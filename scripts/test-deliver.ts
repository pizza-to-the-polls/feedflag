/**
 * Regression tests for the pipeline orchestration contracts (issue #57 —
 * triple helix pillar 1c, stage seams).
 *
 * runPipeline() used to be a ~180-line monolith with six inline numbered
 * stages, ten hard imports, and no seam at which a stage could be exercised.
 * It contains the single most load-bearing expression in the repository —
 * the flag-threshold rule deciding whether a poll-line report reaches a
 * volunteer — with zero coverage. This suite pins:
 *
 *   - the flag rule at its `>=` boundary (exactly flagConfidence flags; one
 *     tick below does not), the archive-only flagCategories behaviour (the
 *     2026-10-18 label-feedback rule: press/community/delivery never flag —
 *     the dispatch signal is LINES), and the absent-flagCategories fallback
 *     to all categories;
 *   - resolveNotifier()'s three branches (Zapier / Slack-with-warning /
 *     null), driven with loadSettings({}) — never process.env;
 *   - every extracted stage (ingestSources, buildQueue, describeAndClassify,
 *     deliverFlags, runCrowdLeg, persistState) with call-recording fakes, so
 *     dryRun is proven to perform ZERO side effects and skipNotify still
 *     persists and emits;
 *   - per-source Promise.allSettled isolation, queue ordering / capping /
 *     sourceFilter, null describe / null classify drops, the crowd-leg skip
 *     and sync-stamp behaviour, and the { processed, flagged } return;
 *   - notify/format.ts literals complementary to scripts/test-locate.ts's
 *     notify gate (which owns the place: confidence floor): flagText's
 *     exact multi-line shape, flagPayload's flat key set, MIN_POST_MINUTES,
 *     and the `(jev-fallback)` provider suffix.
 *
 * All fixtures are synthetic: invented handles and post text,
 * example.invalid URLs, no real accounts or contact info, no network, and
 * no process.env mutation. Full-run scenarios point settings.dataDir at a
 * mkdtemp dir so the real SeenStore writes stay out of the repo. Run:
 * npx tsx scripts/test-deliver.ts — discovered via the scripts/test-*.ts
 * glob.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composite } from "../src/classify/index.js";
import {
  loadSettings,
  settings,
  type FeedsConfig,
  type FeedSource,
  type Settings,
} from "../src/config.js";
import { toObservation } from "../src/emit/records.js";
import type { ResolveDeps } from "../src/locate/types.js";
import type { ResolveInput } from "../src/locate/resolve.js";
import {
  MIN_POST_MINUTES,
  flagPayload,
  flagText,
} from "../src/notify/format.js";
import { resolveNotifier } from "../src/notify/index.js";
import {
  buildQueue,
  createPipelineDeps,
  deliverFlags,
  describeAndClassify,
  ingestSources,
  persistState,
  runCrowdLeg,
  runPipeline,
  shouldFlag,
  type CrowdLegDeps,
  type DescribeClassifyDeps,
  type PersistDeps,
  type PipelineDeps,
  type SeenView,
} from "../src/pipeline.js";
import type {
  Classification,
  DecisionProvider,
  DescriptionSet,
  FeedItem,
  FlaggedItem,
  Notifier,
  Observation,
  ResolvedLocation,
} from "../src/types.js";

console.log("pipeline orchestration regression tests (issue #57)\n");

// ---------------------------------------------------------------------------
// Synthetic fixtures + recording fakes (all injected; nothing global touched)
// ---------------------------------------------------------------------------

let seq = 0;

const CATEGORIES = [
  "poll_line_report", // dispatch
  "wait_time_page_mention", // dispatch
  "press_mention", // archive-only under FLAG_CATEGORIES
  "community_event", // archive-only under FLAG_CATEGORIES
];
/** Label feedback (2026-10-18): only LINES dispatch — the rest archive. */
const FLAG_CATEGORIES = ["poll_line_report", "wait_time_page_mention"];

const NOMATCH: ResolvedLocation = { method: "no-match", confidence: 0 };

const RESOLVED: ResolvedLocation = {
  method: "fuzzy",
  confidence: 0.9,
  location_id: 7,
  name: "Synthetic Community Center",
  address: "100 Synthetic St",
};

function makeFeedItem(over: Partial<FeedItem> = {}): FeedItem {
  seq++;
  return {
    id: `synthetic-post-${seq}`,
    platform: "x",
    authorHandle: "syntheticvoter01",
    postedAt: "2026-11-02T15:00:00.000Z",
    caption: "synthetic caption: long line at the polling place",
    hashtags: ["#synthetic"],
    mediaUrls: [],
    url: `https://example.invalid/p/${seq}`,
    source: "test:synthetic-source",
    ...over,
  };
}

function makeDescription(
  item: FeedItem,
  over: Partial<DescriptionSet> = {},
): DescriptionSet {
  return {
    item,
    caption: item.caption,
    imageDescriptions: ["synthetic image description"],
    ...over,
  };
}

function makeClassification(
  over: Partial<Classification> = {},
): Classification {
  return {
    relevant: true,
    confidence: 0.9,
    category: "poll_line_report",
    provider: "synthetic-jev",
    ...over,
  };
}

function makeFlag(
  over: {
    item?: Partial<FeedItem>;
    classification?: Partial<Classification>;
  } = {},
): FlaggedItem {
  const item = makeFeedItem(over.item);
  return {
    item,
    description: makeDescription(item),
    classification: makeClassification(over.classification),
  };
}

function makeCrowdObservation(id: number | string): Observation {
  return {
    schema: "feedflag/observation@1",
    domain: "crowd",
    source_ref: `pizzabase:reports/${id}`,
    platform: "site",
    observed_at: "2026-11-02T16:00:00.000Z",
    signal_kind: "user_report",
    confidence: 0.95,
    provider: "user-report",
    relevant: true,
    description: makeDescription(
      makeFeedItem({ platform: "site", authorHandle: "site-reporter" }),
    ),
  };
}

/** A Settings object built from an empty env — never process.env — with the
 *  values these tests rely on pinned explicitly. */
function testSettings(over: Partial<Settings> = {}): Settings {
  return {
    ...loadSettings({}),
    flagConfidence: 0.7,
    maxPostsPerRun: 40,
    describeConcurrency: 3,
    siteReportsMax: 50,
    pizzabaseUrl: "",
    ...over,
  };
}

function testFeedsConfig(over: Partial<FeedsConfig> = {}): FeedsConfig {
  return {
    sources: [],
    categories: CATEGORIES,
    flagCategories: FLAG_CATEGORIES,
    ...over,
  };
}

/** SeenView fake recording every has()/addAll() call, backed by an
 *  in-memory set seeded from `initial`. */
class RecordingSeen implements SeenView {
  hasCalls: string[] = [];
  added: { id: string; postedAt: string }[] = [];
  private seenIds = new Set<string>();

  constructor(initial: string[] = []) {
    for (const id of initial) this.seenIds.add(id);
  }

  has(id: string): boolean {
    this.hasCalls.push(id);
    return this.seenIds.has(id);
  }

  async addAll(entries: { id: string; postedAt: string }[]): Promise<void> {
    this.added.push(...entries);
    for (const e of entries) this.seenIds.add(e.id);
  }
}

/** Notifier fake recording notify()/postText() calls (and, when given, the
 *  shared event log so append-vs-notify ordering can be asserted). */
function recordingNotifier(events?: string[]): {
  notifier: Notifier;
  notified: FlaggedItem[];
  postedTexts: string[];
} {
  const notified: FlaggedItem[] = [];
  const postedTexts: string[] = [];
  return {
    notified,
    postedTexts,
    notifier: {
      name: "recording-notifier",
      async notify(f: FlaggedItem) {
        notified.push(f);
        events?.push(`notify:${f.item.id}`);
      },
      async postText(text: string) {
        postedTexts.push(text);
      },
    },
  };
}

function recordingClassify(
  result: Classification | Error | null,
  calls: DescriptionSet[],
): DecisionProvider {
  return {
    name: "fake-classifier",
    classify: async (d) => {
      calls.push(d);
      if (result instanceof Error) throw result;
      return result as Classification;
    },
  };
}

function recordingResolve(
  result: ResolvedLocation | Error,
  calls: ResolveInput[],
): PipelineDeps["resolveLocation"] {
  return async (input) => {
    calls.push(input);
    if (result instanceof Error) throw result;
    return result;
  };
}

/** Swap console.log/warn for string capture; always restore in finally. */
function captureConsole(): {
  logs: string[];
  warns: string[];
  restore(): void;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  return {
    logs,
    warns,
    restore() {
      console.log = origLog;
      console.warn = origWarn;
    },
  };
}

/** Temp dir for full-run scenarios: the real SeenStore inside runPipeline
 *  writes seen.json there, never into the repo's ./data. */
async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "feedflag-test-deliver-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tolerant pizzabase /reports row (structurally the private ReportJson). */
interface Reportish {
  id: number | string;
  createdAt?: string;
  reportURL?: string;
  waitTime?: string | null;
  location?: {
    id?: number | string;
    name?: string;
    city?: string;
    state?: string;
    zip?: string;
    address?: string;
    fullAddress?: string;
    lat?: number;
    lng?: number;
  } | null;
}

function pickDescription(
  init: { description?: DescriptionSet | Error | null },
  item: FeedItem,
): DescriptionSet | Error | null {
  return init.description === undefined
    ? makeDescription(item)
    : init.description;
}

function pickClassification(init: {
  classification?: Classification | Error | null;
}): Classification | Error | null {
  return init.classification === undefined
    ? makeClassification()
    : init.classification;
}

interface FakeBundle {
  deps: PipelineDeps;
  settings: Settings;
  feedsConfig: FeedsConfig;
  notifier: Notifier;
  notified: FlaggedItem[];
  counts: {
    notifierLookups: number;
    stampReads: number;
    stampWrites: number;
    crowdConvertCalls: number;
  };
  ingestCalls: FeedSource[];
  describeCalls: FeedItem[];
  classifyCalls: DescriptionSet[];
  resolveCalls: ResolveInput[];
  events: string[];
  appendedFlags: FlaggedItem[];
  obsBatches: Observation[][];
  crowdFetchCalls: { since: string; max: number }[];
}

/** A full PipelineDeps bundle of recording fakes — drives runPipeline
 *  end-to-end with zero network, zero real writes (only SeenStore touches
 *  the mkdtemp dataDir), and every stage's calls recorded. */
function makeFakes(
  init: {
    settings?: Partial<Settings>;
    feedsConfig?: Partial<FeedsConfig>;
    /** Per-source results in cfg.sources order; an Error fails that source. */
    sourceResults?: (FeedItem[] | Error)[];
    /** Fixed classification; Error/null simulate the classify drop paths. */
    classification?: Classification | Error | null;
    /** Fixed description; Error/null simulate the describe drop paths.
     *  Default: synthesized per item. */
    description?: DescriptionSet | Error | null;
    /** Crowd-leg fetch result (or Error). Default: no reports. */
    reports?: Reportish[] | Error;
  } = {},
): FakeBundle {
  const cfg: FeedsConfig = {
    sources: [],
    categories: CATEGORIES,
    flagCategories: FLAG_CATEGORIES,
    ...init.feedsConfig,
  };
  const s = testSettings(init.settings);
  const rn = recordingNotifier();
  const counts = {
    notifierLookups: 0,
    stampReads: 0,
    stampWrites: 0,
    crowdConvertCalls: 0,
  };
  const b = {
    ingestCalls: [] as FeedSource[],
    describeCalls: [] as FeedItem[],
    classifyCalls: [] as DescriptionSet[],
    resolveCalls: [] as ResolveInput[],
    events: [] as string[],
    appendedFlags: [] as FlaggedItem[],
    obsBatches: [] as Observation[][],
    crowdFetchCalls: [] as { since: string; max: number }[],
  };
  const deps: PipelineDeps = {
    settings: s,
    feedsConfig: cfg,
    ingestFromSource: async (source) => {
      b.ingestCalls.push(source);
      const r = init.sourceResults?.[cfg.sources.indexOf(source)] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    describeItem: async (item) => {
      b.describeCalls.push(item);
      const r = pickDescription(init, item);
      if (r instanceof Error) throw r;
      return r as DescriptionSet;
    },
    classifier: {
      name: "fake-classifier",
      classify: async (d) => {
        b.classifyCalls.push(d);
        const r = pickClassification(init);
        if (r instanceof Error) throw r;
        return r as Classification;
      },
    },
    resolveLocation: async (input) => {
      b.resolveCalls.push(input);
      return RESOLVED;
    },
    createResolveDeps: () => ({}) as ResolveDeps,
    resolveNotifier: () => {
      counts.notifierLookups++;
      return rn.notifier;
    },
    appendFlagged: async (f) => {
      b.appendedFlags.push(f);
      b.events.push(`append:${f.item.id}`);
    },
    appendObservations: async (obs) => {
      b.obsBatches.push(obs);
    },
    readSyncStamp: async () => {
      counts.stampReads++;
      return "2026-11-01T00:00:00.000Z";
    },
    writeSyncStamp: async () => {
      counts.stampWrites++;
    },
    fetchSiteReportsSince: async (since, max) => {
      b.crowdFetchCalls.push({ since, max });
      const r = init.reports ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    reportsToObservations: async (reports) => {
      counts.crowdConvertCalls++;
      return reports.map((r) => makeCrowdObservation(r.id));
    },
    toObservation,
  };
  return {
    deps,
    settings: s,
    feedsConfig: cfg,
    notifier: rn.notifier,
    notified: rn.notified,
    counts,
    ...b,
  };
}

// ---------------------------------------------------------------------------
// Section A — THE flag rule at its boundary (shouldFlag, extracted verbatim)
// ---------------------------------------------------------------------------

/** shouldFlag with the documented default threshold (FLAG_CONFIDENCE=0.7). */
function flagDecision(
  over: Partial<Classification>,
  flagCategories: string[] | undefined,
): boolean {
  return shouldFlag(
    makeClassification(over),
    testSettings({ flagConfidence: 0.7 }),
    CATEGORIES,
    flagCategories,
  );
}

{
  // Exactly at the threshold flags — `>=` is the pinned boundary.
  assert.equal(
    flagDecision({ confidence: 0.7 }, FLAG_CATEGORIES),
    true,
    "confidence == flagConfidence flags (>= boundary)",
  );
  // One tick below does not.
  assert.equal(
    flagDecision({ confidence: 0.699999 }, FLAG_CATEGORIES),
    false,
    "one tick below flagConfidence does not flag",
  );
  // relevant: false at high confidence does not.
  assert.equal(
    flagDecision({ relevant: false, confidence: 0.95 }, FLAG_CATEGORIES),
    false,
    "irrelevant never flags, whatever the confidence",
  );
  // A category outside flagCategories is archive-only (2026-10-18 label
  // feedback): processed but never dispatched.
  assert.equal(
    flagDecision(
      { category: "press_mention", confidence: 0.95 },
      FLAG_CATEGORIES,
    ),
    false,
    "archive-only categories never dispatch — the signal is LINES",
  );
  // flagCategories absent → falls back to every category.
  assert.equal(
    flagDecision({ category: "press_mention" }, undefined),
    true,
    "absent flagCategories falls back to all categories",
  );
  assert.equal(
    flagDecision({ category: "poll_line_report" }, undefined),
    true,
    "absent flagCategories: a line category still flags",
  );

  console.log("  ✓ flag rule: >= boundary, archive-only, fallback");
}

// ---------------------------------------------------------------------------
// Section B — resolveNotifier()'s three branches, injected (no process.env)
// ---------------------------------------------------------------------------

{
  // (1) Zapier catch hook wins.
  const zapierSettings = loadSettings({
    ZAPIER_CATCH_URL: "https://hooks.example.invalid/zapier-catch",
  });
  assert.equal(resolveNotifier(zapierSettings)?.name, "zapier-catch-hook");

  // (2) Slack webhook only → the slack notifier WITH its warning.
  const slackOnly = loadSettings({
    SLACK_WEBHOOK_URL: "https://hooks.example.invalid/slack",
  });
  const cap = captureConsole();
  let slack: Notifier | null = null;
  try {
    slack = resolveNotifier(slackOnly);
  } finally {
    cap.restore();
  }
  assert.equal(slack?.name, "slack");
  assert.equal(cap.warns.length, 1, "exactly one warning");
  assert.match(
    cap.warns[0]!,
    /ZAPIER_CATCH_URL unset — posting direct to Slack webhook/,
  );

  // (3) Neither → null (delivery skipped entirely).
  assert.equal(resolveNotifier(loadSettings({})), null);

  // Precedence: both set → Zapier, silently.
  const bothSettings = loadSettings({
    ZAPIER_CATCH_URL: "https://hooks.example.invalid/zapier-catch",
    SLACK_WEBHOOK_URL: "https://hooks.example.invalid/slack",
  });
  const cap2 = captureConsole();
  let both: Notifier | null = null;
  try {
    both = resolveNotifier(bothSettings);
  } finally {
    cap2.restore();
  }
  assert.equal(both?.name, "zapier-catch-hook");
  assert.equal(cap2.warns.length, 0, "no fallback warning when Zapier is set");

  console.log("  ✓ resolveNotifier: zapier > slack(+warning) > null");
}

// ---------------------------------------------------------------------------
// Section C — Stage 1: ingestSources (per-source allSettled isolation)
// ---------------------------------------------------------------------------

{
  const srcA: FeedSource = {
    platform: "x",
    adapter: "rsshub",
    handle: "synthetic-a",
  };
  const srcB: FeedSource = {
    platform: "instagram",
    adapter: "rsshub",
    handle: "synthetic-b",
  };
  const itemsA = [makeFeedItem(), makeFeedItem()];
  const itemsB = [makeFeedItem()];

  // Both succeed → merged in source order; each source dispatched once.
  const calls: FeedSource[] = [];
  const dispatch = async (source: FeedSource): Promise<FeedItem[]> => {
    calls.push(source);
    return source === srcA ? itemsA : itemsB;
  };
  const cap = captureConsole();
  try {
    const got = await ingestSources([srcA, srcB], dispatch);
    assert.deepEqual(got, [...itemsA, ...itemsB]);
    assert.deepEqual(calls, [srcA, srcB]);
    assert.ok(cap.logs.includes("[feedflag] x/synthetic-a: 2 items"));
    assert.ok(cap.logs.includes("[feedflag] instagram/synthetic-b: 1 items"));
  } finally {
    cap.restore();
  }

  // One source fails → the other is still processed; failure logged; no throw.
  const failingDispatch = async (source: FeedSource): Promise<FeedItem[]> => {
    if (source === srcA) throw new Error("synthetic source outage");
    return itemsB;
  };
  const cap2 = captureConsole();
  try {
    const got2 = await ingestSources([srcA, srcB], failingDispatch);
    assert.deepEqual(got2, itemsB, "the healthy source still lands");
    assert.match(
      cap2.warns[0]!,
      /\[feedflag\] x\/synthetic-a FAILED: Error: synthetic source outage/,
    );
    assert.equal(cap2.logs.length, 1, "only the healthy source logs items");
  } finally {
    cap2.restore();
  }

  // All sources fail → empty result, no throw.
  const allFail = async (): Promise<FeedItem[]> => {
    throw new Error("down");
  };
  assert.deepEqual(await ingestSources([srcA, srcB], allFail), []);

  // No sources → empty result.
  const nothing = async (): Promise<FeedItem[]> => [];
  assert.deepEqual(await ingestSources([], nothing), []);

  console.log("  ✓ ingestSources: isolation, logs, merged order");
}

// ---------------------------------------------------------------------------
// Section C2 — createPipelineDeps' default adapter dispatch (no network):
// guards fire before any transport call, and the pure defaults are wired.
// ---------------------------------------------------------------------------

{
  const s = testSettings({ openrouterKey: "synthetic-key" });
  const cfg = testFeedsConfig();
  const deps = createPipelineDeps(s, cfg);
  assert.equal(deps.settings, s, "settings passed through by reference");
  assert.equal(deps.feedsConfig, cfg, "feeds config passed through");
  assert.equal(deps.toObservation, toObservation, "pure emit default");

  const noHandle: FeedSource = { platform: "x", adapter: "rsshub" };
  const apifyNoToken: FeedSource = {
    platform: "x",
    adapter: "apify",
    actor: "synthetic/actor",
  };
  const unknownAdapter = {
    platform: "x",
    adapter: "vox" as "rsshub" | "apify",
  } as FeedSource;

  await assert.rejects(
    deps.ingestFromSource(noHandle),
    /rsshub source needs a handle/,
  );
  await assert.rejects(
    deps.ingestFromSource(apifyNoToken),
    /APIFY_API_TOKEN not configured/,
  );
  await assert.rejects(
    deps.ingestFromSource(unknownAdapter),
    /unknown adapter "vox"/,
  );

  console.log("  ✓ default deps: adapter guards fire pre-transport");
}

// ---------------------------------------------------------------------------
// Section D — Stage 2: buildQueue (dedupe → seen → newest-first → filter → cap)
// ---------------------------------------------------------------------------

{
  const items = [
    makeFeedItem({
      id: "q-b",
      postedAt: "2026-11-02T15:00:00.000Z",
    }),
    makeFeedItem({
      id: "q-a",
      postedAt: "2026-11-02T16:00:00.000Z",
    }),
    makeFeedItem({
      id: "q-seen",
      postedAt: "2026-11-02T17:00:00.000Z",
    }),
    makeFeedItem({
      id: "q-a", // duplicate id — the first occurrence (16:00) must win
      postedAt: "2026-11-02T14:00:00.000Z",
    }),
    makeFeedItem({
      id: "q-c",
      postedAt: "2026-11-02T12:00:00.000Z",
    }),
  ];

  const seen = new RecordingSeen(["q-seen"]);
  const cap = captureConsole();
  try {
    const queue = await buildQueue(items, seen, {}, testSettings());
    assert.deepEqual(
      queue.map((q) => q.id),
      ["q-a", "q-b", "q-c"],
      "deduped, seen-filtered, newest-first",
    );
    assert.equal(
      queue[0]!.postedAt,
      "2026-11-02T16:00:00.000Z",
      "dedupe kept the FIRST occurrence, then sort put it first",
    );
    assert.ok(seen.hasCalls.includes("q-seen"), "seen was consulted");
    assert.ok(
      cap.logs.includes("[feedflag] 3 new posts to process (5 fetched)"),
      "the queue log line reports both counts",
    );
  } finally {
    cap.restore();
  }

  // sourceFilter matches BOTH "platform/authorHandle" and the source label.
  const xHandle = makeFeedItem({
    id: "xf-1",
    authorHandle: "syntheticvoter01",
    source: "rsshub:x/some-feed",
  });
  const xSrc = makeFeedItem({
    id: "xs-1",
    authorHandle: "otheruser",
    source: "rsshub:instagram/other-feed",
  });
  const qA = await buildQueue(
    [xHandle, xSrc],
    new RecordingSeen(),
    { sourceFilter: "x/syntheticvoter01" },
    testSettings(),
  );
  assert.deepEqual(
    qA.map((q) => q.id),
    ["xf-1"],
    "matched platform/handle",
  );
  const qB = await buildQueue(
    [xHandle, xSrc],
    new RecordingSeen(),
    { sourceFilter: "instagram/other-feed" },
    testSettings(),
  );
  assert.deepEqual(
    qB.map((q) => q.id),
    ["xs-1"],
    "matched the source label",
  );
  const qC = await buildQueue(
    [xHandle],
    new RecordingSeen(),
    { sourceFilter: "no-such-source" },
    testSettings(),
  );
  assert.deepEqual(qC, [], "no match → empty queue");

  // Cap: settings.maxPostsPerRun by default, opts.limit wins when given.
  const many = [0, 1, 2, 3, 4].map((i) =>
    makeFeedItem({
      id: `cap-${i}`,
      postedAt: `2026-11-02T1${9 - i}:00:00.000Z`,
    }),
  );
  const capped = await buildQueue(
    many,
    new RecordingSeen(),
    {},
    testSettings({ maxPostsPerRun: 3 }),
  );
  assert.deepEqual(
    capped.map((q) => q.id),
    ["cap-0", "cap-1", "cap-2"],
    "the NEWEST posts survive the cap",
  );
  const limitOverride = await buildQueue(
    many,
    new RecordingSeen(),
    { limit: 2 },
    testSettings({ maxPostsPerRun: 40 }),
  );
  assert.deepEqual(
    limitOverride.map((q) => q.id),
    ["cap-0", "cap-1"],
    "opts.limit overrides settings.maxPostsPerRun",
  );

  // Empty input → empty queue.
  assert.deepEqual(
    await buildQueue([], new RecordingSeen(), {}, testSettings()),
    [],
  );

  console.log("  ✓ buildQueue: dedupe, seen, newest-first, filter, cap");
}

// ---------------------------------------------------------------------------
// Section E — Stage 3: describeAndClassify (drops, boundary, archive-only)
// ---------------------------------------------------------------------------

{
  const synthesize = async (item: FeedItem) => makeDescription(item);

  function scDeps(over: {
    settings?: Settings;
    describeItem?: PipelineDeps["describeItem"];
    classifier?: DecisionProvider;
    resolveLocation?: PipelineDeps["resolveLocation"];
  }): DescribeClassifyDeps {
    return {
      settings: over.settings ?? testSettings(),
      describeItem: over.describeItem ?? synthesize,
      classifier:
        over.classifier ?? recordingClassify(makeClassification(), []),
      resolveLocation: over.resolveLocation ?? recordingResolve(NOMATCH, []),
      resolver: {} as ResolveDeps,
    };
  }

  // Happy path: all processed and flagged, input order preserved, the
  // resolved place rides on every flag.
  {
    const queue = [makeFeedItem({ id: "p-1" }), makeFeedItem({ id: "p-2" })];
    const resolveCalls: ResolveInput[] = [];
    const deps = scDeps({
      resolveLocation: recordingResolve(RESOLVED, resolveCalls),
    });
    const { done, flagged } = await describeAndClassify(
      queue,
      deps,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      done.map((f) => f.item.id),
      ["p-1", "p-2"],
    );
    assert.deepEqual(
      flagged.map((f) => f.item.id),
      ["p-1", "p-2"],
    );
    assert.equal(flagged[0]!.resolvedLocation!.location_id, 7);
    assert.equal(
      done[0]!.description.item.id,
      "p-1",
      "description passed through by reference",
    );
    assert.equal(resolveCalls.length, 2, "resolve ran once per item");
    assert.equal(
      resolveCalls[0]!.author,
      "syntheticvoter01",
      "the resolver saw the item's author",
    );
  }

  // describeItem throws → that item dropped, the others unaffected, and the
  // classifier never sees the failed item.
  {
    const queue = [makeFeedItem({ id: "d-1" }), makeFeedItem({ id: "d-2" })];
    const describeCalls: FeedItem[] = [];
    const classifyCalls: DescriptionSet[] = [];
    const deps = scDeps({
      // Selective on purpose: a helper that threw for EVERY item would drop
      // d-1 alongside d-2 and prove nothing about per-item isolation — the
      // assertion below would have to expect `[]`. Failing only d-2 is what
      // actually tests the per-item `.catch` in describeAndClassify, so one
      // item's vision failure cannot sink the rest. (The blunt
      // `recordingDescribe(error, calls)` helper this replaced caused exactly
      // that false expectation, and is gone.)
      describeItem: async (item) => {
        describeCalls.push(item);
        if (item.id === "d-2") throw new Error("synthetic vision outage");
        return makeDescription(item);
      },
      classifier: recordingClassify(makeClassification(), classifyCalls),
    });
    const cap = captureConsole();
    try {
      const { done } = await describeAndClassify(
        queue,
        deps,
        CATEGORIES,
        FLAG_CATEGORIES,
      );
      assert.deepEqual(
        done.map((f) => f.item.id),
        ["d-1"],
      );
      assert.deepEqual(
        classifyCalls.map((d) => d.item.id),
        ["d-1"],
      );
      assert.match(
        cap.warns[0]!,
        /\[feedflag\] describe failed d-2: Error: synthetic vision outage/,
      );
    } finally {
      cap.restore();
    }
  }

  // describeItem resolving null (the caught-null shape) → that item dropped,
  // the rest unaffected. Selective for the same reason as the throwing case
  // above: a blanket `null` drops n-1 and n-2 alike and asserts nothing.
  {
    const queue = [makeFeedItem({ id: "n-1" }), makeFeedItem({ id: "n-2" })];
    const deps = scDeps({
      describeItem: async (item) =>
        item.id === "n-1" ? null : makeDescription(item),
    });
    const { done } = await describeAndClassify(
      queue,
      deps,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      done.map((f) => f.item.id),
      ["n-2"],
      "a null description drops only that item",
    );
  }

  // classify throws → that item dropped, the rest unaffected; and the same for
  // a classify that resolves null. Both fakes fail c-1 only: a blanket failure
  // would drop c-2 as well, contradicting the `classify failed c-1` warning
  // asserted below and proving nothing about per-item isolation.
  {
    const queue = [makeFeedItem({ id: "c-1" }), makeFeedItem({ id: "c-2" })];
    const deps = scDeps({
      classifier: {
        name: "selective-throw",
        classify: async (d) => {
          if (d.item.id === "c-1") throw new Error("synthetic jev outage");
          return makeClassification();
        },
      },
    });
    const cap = captureConsole();
    try {
      const { done } = await describeAndClassify(
        queue,
        deps,
        CATEGORIES,
        FLAG_CATEGORIES,
      );
      assert.deepEqual(
        done.map((f) => f.item.id),
        ["c-2"],
        "a classify throw drops only that item",
      );
      assert.match(
        cap.warns[0]!,
        /\[feedflag\] classify failed c-1: Error: synthetic jev outage/,
      );
    } finally {
      cap.restore();
    }
    const depsNull = scDeps({
      classifier: {
        name: "selective-null",
        classify: async (d) =>
          d.item.id === "c-1" ? null! : makeClassification(),
      },
    });
    const { done: doneNull } = await describeAndClassify(
      queue,
      depsNull,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      doneNull.map((f) => f.item.id),
      ["c-2"],
      "a null classification drops only that item",
    );
  }

  // resolveLocation throwing is belt-and-braces caught → no-match, and the
  // item is still processed and flagged.
  {
    const deps = scDeps({
      resolveLocation: recordingResolve(new Error("resolver down"), []),
    });
    const { done, flagged } = await describeAndClassify(
      [makeFeedItem({ id: "r-1" })],
      deps,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      done.map((f) => f.item.id),
      ["r-1"],
    );
    assert.deepEqual(flagged[0]!.resolvedLocation, NOMATCH);
  }

  // THE boundary, through the stage: confidence exactly flagConfidence
  // flags; one tick below is processed but not flagged.
  {
    const deps = scDeps({
      classifier: recordingClassify(
        makeClassification({ confidence: 0.7 }),
        [],
      ),
    });
    const at = await describeAndClassify(
      [makeFeedItem({ id: "b-at" })],
      deps,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      at.flagged.map((f) => f.item.id),
      ["b-at"],
    );

    const depsBelow = scDeps({
      classifier: recordingClassify(
        makeClassification({ confidence: 0.69 }),
        [],
      ),
    });
    const below = await describeAndClassify(
      [makeFeedItem({ id: "b-below" })],
      depsBelow,
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      below.done.map((f) => f.item.id),
      ["b-below"],
    );
    assert.deepEqual(below.flagged, [], "0.69 < 0.7 is archived, not flagged");
  }

  // Archive-only through the stage: a confident press_mention is processed
  // but never flagged; with flagCategories absent it WOULD flag.
  {
    const press = makeClassification({
      category: "press_mention",
      confidence: 0.95,
    });
    const archived = await describeAndClassify(
      [makeFeedItem({ id: "arch-1" })],
      scDeps({ classifier: recordingClassify(press, []) }),
      CATEGORIES,
      FLAG_CATEGORIES,
    );
    assert.deepEqual(
      archived.done.map((f) => f.item.id),
      ["arch-1"],
    );
    assert.deepEqual(archived.flagged, [], "archive-only: no dispatch");

    const fallback = await describeAndClassify(
      [makeFeedItem({ id: "arch-2" })],
      scDeps({ classifier: recordingClassify(press, []) }),
      CATEGORIES,
      undefined,
    );
    assert.deepEqual(
      fallback.flagged.map((f) => f.item.id),
      ["arch-2"],
    );
  }

  console.log("  ✓ describeAndClassify: drops, boundary, archive-only");
}

// ---------------------------------------------------------------------------
// Section F — Stage 4: deliverFlags (append + notify + log; dryRun skips both)
// ---------------------------------------------------------------------------

{
  const flags = [
    makeFlag({
      item: { id: "flag-1" },
      classification: {
        category: "poll_line_report",
        confidence: 0.85,
        provider: "synthetic-jev",
      },
    }),
    makeFlag({ item: { id: "flag-2" } }),
  ];

  // Normal: append BEFORE notify per flag, both flags logged with the exact
  // line format.
  {
    const events: string[] = [];
    const appendCalls: FlaggedItem[] = [];
    const rn = recordingNotifier(events);
    const appendFn: PipelineDeps["appendFlagged"] = async (f) => {
      appendCalls.push(f);
      events.push(`append:${f.item.id}`);
    };
    const cap = captureConsole();
    try {
      await deliverFlags(flags, rn.notifier, {}, appendFn);
    } finally {
      cap.restore();
    }
    assert.deepEqual(appendCalls, flags);
    assert.deepEqual(rn.notified, flags);
    assert.equal(
      events.join("|"),
      "append:flag-1|notify:flag-1|append:flag-2|notify:flag-2",
    );
    assert.ok(
      cap.logs.includes(
        "🚩 x/@syntheticvoter01 -> poll_line_report (85% via synthetic-jev)",
      ),
    );
  }

  // dryRun: appendFlagged NEVER called, notifier NEVER called, log still
  // produced (the operator sees what would have been delivered).
  {
    const events: string[] = [];
    let appendCalls = 0;
    const rn = recordingNotifier(events);
    const appendFnDry: PipelineDeps["appendFlagged"] = async () => {
      appendCalls++;
    };
    const cap = captureConsole();
    try {
      await deliverFlags(flags, rn.notifier, { dryRun: true }, appendFnDry);
    } finally {
      cap.restore();
    }
    assert.equal(appendCalls, 0, "dryRun appends nothing");
    assert.equal(rn.notified.length, 0, "dryRun delivers nothing");
    assert.deepEqual(events, [], "zero side effects");
    assert.equal(cap.logs.length, flags.length, "the log line still shows");
  }

  // Null notifier (the orchestrator's skipNotify shape): appends happen, no
  // notify call exists to make, log produced.
  {
    const appendCalls: FlaggedItem[] = [];
    const appendFn2: PipelineDeps["appendFlagged"] = async (f) => {
      appendCalls.push(f);
    };
    const cap = captureConsole();
    try {
      await deliverFlags(flags, null, {}, appendFn2);
    } finally {
      cap.restore();
    }
    assert.deepEqual(appendCalls, flags);
    assert.equal(cap.logs.length, flags.length);
  }

  // A notifier failure is swallowed per flag: the next flag is still
  // appended, notified-attempted, and logged.
  {
    const appendCalls: FlaggedItem[] = [];
    const failing: Notifier = {
      name: "failing-notifier",
      notify: async () => {
        throw new Error("synthetic slack outage");
      },
      postText: async () => {},
    };
    const appendFn3: PipelineDeps["appendFlagged"] = async (f) => {
      appendCalls.push(f);
    };
    const cap = captureConsole();
    try {
      await deliverFlags(flags, failing, {}, appendFn3);
    } finally {
      cap.restore();
    }
    assert.deepEqual(appendCalls, flags, "both flags still persisted");
    assert.equal(cap.logs.length, flags.length, "both flags still logged");
    assert.match(
      cap.warns[0]!,
      /\[feedflag\] notify failed: Error: synthetic slack outage/,
    );
  }

  console.log("  ✓ deliverFlags: order, dryRun zero effects, swallow");
}

// ---------------------------------------------------------------------------
// Section G — Stage 5: runCrowdLeg (skip, fetch window, convert, degrade)
// ---------------------------------------------------------------------------

{
  const reports: Reportish[] = [
    {
      id: 1,
      createdAt: "2026-11-02T16:00:00.000Z",
      reportURL: "https://example.invalid/r/1",
      waitTime: "20 min",
    },
    {
      id: 2,
      createdAt: "2026-11-02T16:05:00.000Z",
    },
  ];

  function makeCrowdDeps(over: {
    settings?: Partial<Settings>;
    fetch?: CrowdLegDeps["fetchSiteReportsSince"];
    convert?: CrowdLegDeps["reportsToObservations"];
  }): { deps: CrowdLegDeps; stampReads: () => number } {
    let stampReads = 0;
    const deps: CrowdLegDeps = {
      settings: testSettings({
        pizzabaseUrl: "https://example.invalid/pizzabase",
        ...over.settings,
      }),
      readSyncStamp: async () => {
        stampReads++;
        return "2026-11-01T00:00:00.000Z";
      },
      // Field names must match `CrowdLegDeps` = Pick<PipelineDeps, …>:
      // `fetchSiteReportsSince` / `reportsToObservations`. `scripts/` is not in
      // tsconfig's include, so tsc never checks this file and a wrong name
      // only surfaces at runtime as "is not a function".
      fetchSiteReportsSince: over.fetch ?? (async () => reports),
      reportsToObservations:
        over.convert ??
        (async (rs) => rs.map((r) => makeCrowdObservation(r.id))),
    };
    return { deps, stampReads: () => stampReads };
  }

  // (a) Skipped entirely when pizzabaseUrl is empty: not even the stamp read.
  {
    const { deps, stampReads } = makeCrowdDeps({
      settings: { pizzabaseUrl: "" },
    });
    let fetchCalls = 0;
    const depsNoFetch: CrowdLegDeps = {
      ...deps,
      fetchSiteReportsSince: async () => {
        fetchCalls++;
        return [];
      },
    };
    const cap = captureConsole();
    try {
      const crowd = await runCrowdLeg(depsNoFetch, {});
      assert.deepEqual(crowd, []);
      assert.equal(stampReads(), 0, "the stamp is not even read");
      assert.equal(fetchCalls, 0, "no fetch without a pizzabase URL");
      assert.equal(cap.logs.length, 0, "nothing logged for a skipped leg");
    } finally {
      cap.restore();
    }
  }

  // (b) Reports flow: stamp read → fetch → convert → the exact log line.
  {
    const { deps, stampReads } = makeCrowdDeps({});
    const cap = captureConsole();
    try {
      const crowd = await runCrowdLeg(deps, {});
      assert.deepEqual(
        crowd.map((o) => o.source_ref),
        ["pizzabase:reports/1", "pizzabase:reports/2"],
      );
      assert.equal(stampReads(), 1, "the stamp was read once");
      assert.ok(
        cap.logs.includes(
          "[feedflag] crowd leg: 2 site reports -> observations " +
            "(archived; no Slack — reports already surface via #feed-reports)",
        ),
      );
    } finally {
      cap.restore();
    }
  }

  // (c) The fetch window: since = the stamp; max = opts.limit override, else
  // settings.siteReportsMax.
  {
    const fetchCalls: { since: string; max: number }[] = [];
    const { deps } = makeCrowdDeps({
      fetch: async (since, max) => {
        fetchCalls.push({ since, max });
        return [];
      },
    });
    await runCrowdLeg(deps, {});
    assert.deepEqual(fetchCalls, [
      { since: "2026-11-01T00:00:00.000Z", max: 50 },
    ]);
    fetchCalls.length = 0;
    await runCrowdLeg(deps, { limit: 5 });
    assert.deepEqual(fetchCalls, [
      { since: "2026-11-01T00:00:00.000Z", max: 5 },
    ]);
  }

  // (d) Fetch failure degrades to zero reports; the run continues.
  {
    let converted = 0;
    const { deps, stampReads } = makeCrowdDeps({
      fetch: async () => {
        throw new Error("synthetic pizzabase outage");
      },
      convert: async (rs) => {
        converted = rs.length;
        return rs.map((r) => makeCrowdObservation(r.id));
      },
    });
    const cap = captureConsole();
    try {
      const crowd = await runCrowdLeg(deps, {});
      assert.deepEqual(crowd, []);
      assert.equal(converted, 0, "nothing converted after a failed fetch");
      assert.equal(stampReads(), 1, "the stamp was read before the failure");
      assert.match(
        cap.warns[0]!,
        /\[feedflag\] crowd leg failed: Error: synthetic pizzabase outage/,
      );
    } finally {
      cap.restore();
    }
  }

  // (e) Zero fetched reports → nothing converted, no crowd log line.
  {
    let convertCalls = 0;
    const { deps } = makeCrowdDeps({
      fetch: async () => [],
      convert: async (rs) => {
        convertCalls++;
        return rs.map((r) => makeCrowdObservation(r.id));
      },
    });
    const cap = captureConsole();
    try {
      const crowd = await runCrowdLeg(deps, {});
      assert.deepEqual(crowd, []);
      assert.equal(convertCalls, 0, "nothing to convert");
      assert.equal(cap.logs.length, 0, "no crowd log line");
    } finally {
      cap.restore();
    }
  }

  console.log("  ✓ runCrowdLeg: skip, window, convert, degrade");
}

// ---------------------------------------------------------------------------
// Section H — Stage 6: persistState (append + stamp + seen; dryRun skips all)
// ---------------------------------------------------------------------------

{
  const flags = [
    makeFlag({ item: { id: "per-1" } }),
    makeFlag({ item: { id: "per-2" } }),
  ];
  const crowd = [makeCrowdObservation(9)];

  // Normal: one batch = done.map(toObservation) ++ crowd, stamp written,
  // seen.addAll records id→postedAt.
  {
    const seen = new RecordingSeen();
    const obsBatches: Observation[][] = [];
    let stampWrites = 0;
    const deps: PersistDeps = {
      appendObservations: async (obs) => {
        obsBatches.push(obs);
      },
      writeSyncStamp: async () => {
        stampWrites++;
      },
      toObservation,
    };
    await persistState(flags, crowd, seen, {}, deps);
    assert.equal(obsBatches.length, 1);
    assert.equal(obsBatches[0]!.length, 3);
    assert.equal(obsBatches[0]![0]!.domain, "social");
    assert.equal(
      obsBatches[0]![0]!.source_ref,
      flags[0]!.item.source,
      "social observations come from the real toObservation",
    );
    assert.equal(obsBatches[0]![2]!.domain, "crowd");
    assert.equal(stampWrites, 1, "the sync stamp advanced");
    assert.deepEqual(
      seen.added,
      flags.map((f) => ({ id: f.item.id, postedAt: f.item.postedAt })),
    );
  }

  // dryRun: ZERO side effects — no appendObservations, no writeSyncStamp,
  // no seen.addAll.
  {
    const seen = new RecordingSeen();
    let appendCalls = 0;
    let stampWrites = 0;
    const deps: PersistDeps = {
      appendObservations: async () => {
        appendCalls++;
      },
      writeSyncStamp: async () => {
        stampWrites++;
      },
      toObservation,
    };
    await persistState(flags, crowd, seen, { dryRun: true }, deps);
    assert.equal(appendCalls, 0, "dryRun appends no observations");
    assert.equal(stampWrites, 0, "dryRun writes no sync stamp");
    assert.equal(seen.added.length, 0, "dryRun marks nothing seen");
    assert.equal(seen.hasCalls.length, 0, "persist never consults seen.has");
  }

  console.log("  ✓ persistState: full on normal, zero on dryRun");
}

// ---------------------------------------------------------------------------
// Section I — the thin orchestrator: runPipeline with a full fake bundle
// ---------------------------------------------------------------------------

const TWO_SOURCES: FeedSource[] = [
  { platform: "x", adapter: "rsshub", handle: "synthetic-one" },
  { platform: "instagram", adapter: "rsshub", handle: "synthetic-two" },
];

function fullRunItems(): FeedItem[] {
  return [
    makeFeedItem({ id: "run-a", postedAt: "2026-11-02T15:00:00.000Z" }),
    makeFeedItem({ id: "run-b", postedAt: "2026-11-02T16:00:00.000Z" }),
    makeFeedItem({ id: "run-c", postedAt: "2026-11-02T14:00:00.000Z" }),
  ];
}

{
  // (1) Normal run: the { processed, flagged } return, every side effect via
  // the injected deps, the exact run-complete log line.
  await withTmpDir(async (dir) => {
    const items = fullRunItems();
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[items[0]!, items[1]!], [items[2]!]],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({}, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 3, flagged: 3 });
    assert.equal(f.appendedFlags.length, 3, "every flag appended");
    assert.equal(f.notified.length, 3, "every flag notified");
    assert.equal(f.counts.notifierLookups, 1, "notifier resolved once");
    assert.equal(f.obsBatches.length, 1);
    assert.equal(f.obsBatches[0]!.length, 3, "3 social + 0 crowd observations");
    assert.equal(f.counts.stampWrites, 1, "sync stamp advanced");
    assert.equal(f.ingestCalls.length, 2, "both sources dispatched");

    // The real SeenStore (wired from deps.settings.dataDir) recorded the run.
    const seenRaw = JSON.parse(
      await readFile(join(dir, "seen.json"), "utf8"),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(seenRaw).sort(), ["run-a", "run-b", "run-c"]);
    // Everything else flowed through the fakes — no stray audit files.
    assert.equal(
      existsSync(join(dir, "flagged.jsonl")),
      false,
      "flag persistence went through the injected appendFlagged",
    );

    assert.ok(cap.logs.includes("[feedflag] x/synthetic-one: 2 items"));
    assert.ok(cap.logs.includes("[feedflag] instagram/synthetic-two: 1 items"));
    assert.ok(
      cap.logs.includes("[feedflag] 3 new posts to process (3 fetched)"),
    );
    assert.ok(
      cap.logs.includes("[feedflag] run complete: 3 processed, 3 flagged"),
    );
  });

  // (2) dryRun: the counts still return, but ZERO side effects anywhere —
  // no appendFlagged, no notify, no observations, no stamp, no seen.json,
  // and resolveNotifier is not even consulted.
  await withTmpDir(async (dir) => {
    const items = fullRunItems();
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[items[0]!, items[1]!], [items[2]!]],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({ dryRun: true }, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 3, flagged: 3 });
    assert.equal(f.appendedFlags.length, 0, "dryRun appends nothing");
    assert.equal(f.notified.length, 0, "dryRun delivers nothing");
    assert.equal(f.obsBatches.length, 0, "dryRun emits no observations");
    assert.equal(f.counts.stampWrites, 0, "dryRun writes no sync stamp");
    assert.equal(
      f.counts.notifierLookups,
      0,
      "dryRun never resolves a notifier",
    );
    assert.equal(
      existsSync(join(dir, "seen.json")),
      false,
      "dryRun marks nothing seen",
    );
    assert.ok(
      cap.logs.includes(
        "[feedflag] run complete: 3 processed, 3 flagged " +
          "(dry run — nothing delivered)",
      ),
    );
  });

  // (3) skipNotify: still persists and emits — only the notifier is skipped,
  // and it is not even resolved.
  await withTmpDir(async (dir) => {
    const items = fullRunItems();
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[items[0]!, items[1]!], [items[2]!]],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({ skipNotify: true }, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 3, flagged: 3 });
    assert.equal(f.appendedFlags.length, 3, "skipNotify still persists flags");
    assert.equal(f.notified.length, 0, "skipNotify delivers nothing");
    assert.equal(f.obsBatches.length, 1, "skipNotify still emits");
    assert.equal(
      f.counts.stampWrites,
      1,
      "skipNotify still advances the stamp",
    );
    assert.equal(f.counts.notifierLookups, 0);
    const seenRaw = JSON.parse(
      await readFile(join(dir, "seen.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(Object.keys(seenRaw).length, 3, "skipNotify still marks seen");
  });

  // (4) Per-source isolation through the orchestrator: a failed source logs
  // its failure and the run completes with the healthy source's items.
  await withTmpDir(async (dir) => {
    const item = makeFeedItem({ id: "solo-1" });
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [new Error("synthetic rsshub outage"), [item]],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({}, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 1, flagged: 1 });
    assert.match(
      cap.warns[0]!,
      /\[feedflag\] x\/synthetic-one FAILED: Error: synthetic rsshub outage/,
    );
    assert.ok(
      cap.logs.includes("[feedflag] run complete: 1 processed, 1 flagged"),
    );
  });

  // (5) Crowd leg through the orchestrator: reports join the social
  // observations in one bus batch; the stamp was read before fetching.
  await withTmpDir(async (dir) => {
    const item = makeFeedItem({ id: "crowd-run-1" });
    const f = makeFakes({
      settings: {
        dataDir: dir,
        pizzabaseUrl: "https://example.invalid/pizzabase",
      },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[], [item]],
      reports: [{ id: 11, createdAt: "2026-11-02T16:00:00.000Z" }],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({}, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 1, flagged: 1 });
    assert.equal(f.obsBatches.length, 1);
    assert.equal(f.obsBatches[0]!.length, 2, "1 social + 1 crowd");
    assert.equal(f.obsBatches[0]![1]!.domain, "crowd");
    assert.equal(f.counts.stampReads, 1);
    assert.deepEqual(f.crowdFetchCalls, [
      { since: "2026-11-01T00:00:00.000Z", max: 50 },
    ]);
    assert.ok(
      cap.logs.some((l) =>
        l.startsWith("[feedflag] crowd leg: 1 site reports"),
      ),
    );
  });

  // (6) Crowd leg skipped when pizzabaseUrl is empty: no stamp read, no
  // fetch, and only social observations on the bus.
  await withTmpDir(async (dir) => {
    const item = makeFeedItem({ id: "nocrowd-1" });
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[], [item]],
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({}, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 1, flagged: 1 });
    assert.equal(f.obsBatches[0]!.length, 1);
    assert.equal(
      f.counts.stampReads,
      0,
      "the skipped leg never read the stamp",
    );
    assert.equal(f.crowdFetchCalls.length, 0);
  });

  // (7) Every describe failing drops every item without sinking the run:
  // 0 processed, 0 flagged, an empty bus batch, and an empty seen store
  // (addAll still ran — with zero entries).
  await withTmpDir(async (dir) => {
    const f = makeFakes({
      settings: { dataDir: dir },
      feedsConfig: { sources: TWO_SOURCES },
      sourceResults: [[makeFeedItem()]],
      description: new Error("synthetic total vision outage"),
    });
    const cap = captureConsole();
    let res: { processed: number; flagged: number };
    try {
      res = await runPipeline({}, f.deps);
    } finally {
      cap.restore();
    }
    assert.deepEqual(res, { processed: 0, flagged: 0 });
    assert.equal(f.appendedFlags.length, 0);
    assert.equal(f.obsBatches.length, 1, "the run still persisted its state");
    assert.equal(f.obsBatches[0]!.length, 0, "with zero observations");
    const seenRaw = JSON.parse(
      await readFile(join(dir, "seen.json"), "utf8"),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(seenRaw), []);
    assert.ok(
      cap.logs.includes("[feedflag] run complete: 0 processed, 0 flagged"),
    );
  });

  console.log("  ✓ runPipeline: return, dryRun, skipNotify, isolation");
}

// ---------------------------------------------------------------------------
// Section J — notify/format.ts literals, complementary to test-locate.ts's
// notify gate (which owns the place: confidence floor and its boundaries)
// ---------------------------------------------------------------------------

{
  // The dispatch threshold shared with the govt leg.
  assert.equal(MIN_POST_MINUTES, 60);

  const item = makeFeedItem({
    id: "fmt-1",
    platform: "instagram",
    authorHandle: "synthetic-account",
    caption: "synthetic line caption",
    url: "https://example.invalid/p/42",
    mediaUrls: ["https://cdn.example.invalid/pic.jpg"],
  });
  const flag: FlaggedItem = {
    item,
    description: makeDescription(item, {
      imageDescriptions: ["synthetic frame one", "synthetic frame two"],
    }),
    classification: makeClassification({
      category: "poll_line_report",
      confidence: 0.91,
      provider: "synthetic-jev",
    }),
  };

  // flagText's exact multi-line shape: head / who / body / media / link
  // (no place line — this flag carries no resolvedLocation, so the floor is
  // never consulted and the assertion is deterministic).
  const expectedFlagText =
    "🚩 *poll_line_report* — 91% conf (synthetic-jev)\n" +
    "@synthetic-account on instagram\n" +
    "synthetic line caption\n" +
    "Images: synthetic frame one | synthetic frame two\n" +
    "https://example.invalid/p/42";
  assert.equal(flagText(flag), expectedFlagText);

  // With a confident resolved place, the place line slots in before the link
  // (the floor is forced to its documented default for determinism).
  const savedFloor = settings.resolveSlackMinConfidence;
  try {
    settings.resolveSlackMinConfidence = 0.8;
    const withPlace: FlaggedItem = {
      ...flag,
      resolvedLocation: {
        method: "fuzzy",
        confidence: 0.9,
        location_id: 3,
        name: "Synthetic Community Center",
        address: "100 Synthetic St",
      },
    };
    const expectedWithPlace =
      "🚩 *poll_line_report* — 91% conf (synthetic-jev)\n" +
      "@synthetic-account on instagram\n" +
      "synthetic line caption\n" +
      "Images: synthetic frame one | synthetic frame two\n" +
      "place: 100 Synthetic St (fuzzy match)\n" +
      "https://example.invalid/p/42";
    assert.equal(flagText(withPlace), expectedWithPlace);
    assert.equal(
      flagPayload(withPlace).resolved_place,
      "100 Synthetic St",
      "a showable place reaches the payload field",
    );

    // Degradations: no media line, "(no caption)" fallback, no link line.
    const bareItem = makeFeedItem({
      id: "fmt-2",
      caption: "",
      url: undefined,
      mediaUrls: [],
    });
    const bare: FlaggedItem = {
      item: bareItem,
      description: makeDescription(bareItem, { imageDescriptions: [] }),
      classification: makeClassification({
        category: "wait_time_page_mention",
        confidence: 0.7,
      }),
    };
    const expectedBare =
      "🚩 *wait_time_page_mention* — 70% conf (synthetic-jev)\n" +
      "@syntheticvoter01 on x\n" +
      "(no caption)";
    assert.equal(flagText(bare), expectedBare);
  } finally {
    settings.resolveSlackMinConfidence = savedFloor;
  }
  assert.equal(settings.resolveSlackMinConfidence, savedFloor, "restored");

  // flagPayload's flat key set — the contract Zapier maps fields from.
  const payload = flagPayload(flag);
  assert.equal(
    Object.keys(payload).join(","),
    "text,platform,author,url,posted_at,category,confidence,provider," +
      "caption,image_descriptions,media_urls,media_embed,resolved_place," +
      "resolved_place_method,resolved_place_confidence",
  );
  assert.equal(payload.text, flagText(flag));
  assert.equal(payload.platform, "instagram");
  assert.equal(payload.author, "synthetic-account");
  assert.equal(payload.url, "https://example.invalid/p/42");
  assert.equal(payload.posted_at, item.postedAt);
  assert.equal(payload.category, "poll_line_report");
  assert.equal(payload.confidence, 0.91);
  assert.equal(payload.provider, "synthetic-jev");
  assert.equal(payload.caption, "synthetic line caption");
  const expectedImages = ["synthetic frame one", "synthetic frame two"];
  assert.deepEqual(payload.image_descriptions, expectedImages);
  assert.deepEqual(payload.media_urls, item.mediaUrls);
  assert.equal(
    payload.media_embed,
    "https://cdn.example.invalid/pic.jpg",
    "the first embeddable image rides as media_embed",
  );
  assert.equal(payload.resolved_place_method, "");
  assert.equal(payload.resolved_place_confidence, 0);

  console.log("  ✓ format literals: flagText, payload keys, 60min");
}

// ---------------------------------------------------------------------------
// Section J2 — the `(jev-fallback)` provider suffix (classify composite)
// ---------------------------------------------------------------------------

{
  const desc = makeDescription(makeFeedItem({ id: "jev-1" }));
  const failingJev: DecisionProvider = {
    name: "synthetic-jev",
    classify: async () => {
      throw new Error("synthetic jev outage");
    },
  };
  const fallbackProvider: DecisionProvider = {
    name: "synthetic-fallback",
    classify: async () =>
      makeClassification({ provider: "synthetic-fallback" }),
  };

  // The failure path renames the provider with the (jev-fallback) suffix —
  // the audit trail distinguishing calibrated from uncalibrated confidence.
  const composed = composite(failingJev, fallbackProvider);
  const cap = captureConsole();
  try {
    const out = await composed.classify(desc, CATEGORIES);
    assert.equal(out.provider, "synthetic-fallback (jev-fallback)");
    assert.match(
      cap.warns[0]!,
      /jev classify failed .*falling back to synthetic-fallback/,
    );
  } finally {
    cap.restore();
  }

  // The happy path passes Jev's own provider through untouched.
  const okJev: DecisionProvider = {
    name: "synthetic-jev",
    classify: async () => makeClassification({ provider: "synthetic-jev" }),
  };
  const happy = composite(okJev, fallbackProvider);
  const passthrough = await happy.classify(desc, CATEGORIES);
  assert.equal(passthrough.provider, "synthetic-jev", "no suffix on success");

  console.log("  ✓ composite: (jev-fallback) suffix, passthrough");
}

console.log("\nAll pipeline orchestration regression tests passed.");
