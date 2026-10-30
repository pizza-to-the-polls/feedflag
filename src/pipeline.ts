/**
 * One pipeline run: ingest → dedupe/filter → describe → classify → flag →
 * deliver → crowd leg → persist.
 *
 * Issue #57 (triple helix pillar 1c): the six numbered stages are extracted
 * into named, individually callable functions, each taking its dependencies
 * as plain arguments (the ResolveDeps house style — no DI container, no
 * decorators). `runPipeline()` stays the thin orchestrator that wires the
 * production defaults; external behaviour, ordering, log text, and the
 * `{ processed, flagged }` return are unchanged. Every seam is injectable so
 * scripts/test-deliver.ts can pin the orchestration contracts — the
 * flag-threshold rule, per-source isolation, queue ordering, dry-run zero
 * side effects — with recording fakes and no network.
 */
import {
  loadFeedsConfig,
  settings,
  type FeedsConfig,
  type FeedSource,
  type Settings,
} from "./config.js";
import { fetchViaRsshub } from "./ingest/rsshub.js";
import { normalizeApifyRecord, runApifyActor } from "./ingest/apify.js";
import { describeItem } from "./describe/openrouter.js";
import { resolveClassifier } from "./classify/index.js";
import { resolveNotifier } from "./notify/index.js";
import {
  appendFlagged,
  appendObservations,
  readSyncStamp,
  writeSyncStamp,
  SeenStore,
} from "./store/jsonl.js";
import { toObservation } from "./emit/records.js";
import {
  NO_MATCH,
  createResolveDeps,
  resolveLocation,
} from "./locate/resolve.js";
import type { ResolveDeps } from "./locate/types.js";
import {
  fetchSiteReportsSince,
  reportsToObservations,
} from "./ingest/reports.js";
import { dedupeById, mapLimit } from "./util.js";
import type {
  Classification,
  DecisionProvider,
  DescriptionSet,
  FeedItem,
  FlaggedItem,
  HttpTransport,
  Notifier,
  Observation,
} from "./types.js";

export interface RunOptions {
  dryRun?: boolean;
  limit?: number;
  skipNotify?: boolean;
  /** Substring match against "platform/handle" or source label */
  sourceFilter?: string;
}

/** The pipeline's injectable dependency bundle (issue #57) — one object
 *  holding every swappable piece, defaulted to today's real implementations
 *  by `createPipelineDeps()`. Plain functions and interfaces in the
 *  ResolveDeps house style; tests override individual fields. */
export interface PipelineDeps {
  settings: Settings;
  feedsConfig: FeedsConfig;
  /** Stage 1: one source → its FeedItem[] (the rsshub/apify dispatch). */
  ingestFromSource: (source: FeedSource) => Promise<FeedItem[]>;
  /** Stage 3: OpenRouter vision description set for one item. */
  describeItem: (
    item: FeedItem,
    s?: Settings,
    transport?: HttpTransport,
  ) => Promise<DescriptionSet>;
  /** Stage 3: the decision layer (Jev / LLM fallback). */
  classifier: DecisionProvider;
  /** Stage 3: location triangulation (issue #35). */
  resolveLocation: typeof resolveLocation;
  /** Fresh ResolveDeps for one run (one shared PizzabaseApi cache). */
  createResolveDeps: typeof createResolveDeps;
  /** Stage 4: Zapier → Slack webhook → null notifier selection. */
  resolveNotifier: typeof resolveNotifier;
  /** Stage 4: the flagged.jsonl audit append. */
  appendFlagged: typeof appendFlagged;
  /** Stage 5: the pizzabase /reports crowd leg. */
  fetchSiteReportsSince: typeof fetchSiteReportsSince;
  reportsToObservations: typeof reportsToObservations;
  /** Stage 6: the observations.jsonl bus append + crowd sync cursor. */
  appendObservations: typeof appendObservations;
  readSyncStamp: typeof readSyncStamp;
  writeSyncStamp: typeof writeSyncStamp;
  /** Stage 6: FlaggedItem → aggregator-ready observation. */
  toObservation: typeof toObservation;
}

/** Production defaults builder — the settings singleton, the real feeds
 *  config, and the real implementation of every stage dependency. Tests pass
 *  synthetic Settings / FeedsConfig and override fields instead.
 *
 *  Note: the classifier is resolved eagerly (exactly as runPipeline always
 *  did), so a bundle built without OPENROUTER_API_KEY throws "No classifier
 *  configured" at bundle-creation time — earlier than the historical
 *  mid-run throw point, with the identical error. */
export function createPipelineDeps(
  s: Settings = settings,
  cfg?: FeedsConfig,
): PipelineDeps {
  return {
    settings: s,
    feedsConfig: cfg ?? loadFeedsConfig(),
    ingestFromSource: async (source) => {
      if (source.adapter === "rsshub") {
        if (!source.handle)
          throw new Error(
            `rsshub source needs a handle: ${JSON.stringify(source)}`,
          );
        return fetchViaRsshub(
          source.platform,
          source.handle,
          `rsshub:${source.platform}/${source.handle}`,
          source.limit ?? 20,
        );
      }
      if (source.adapter === "apify") {
        if (!source.actor)
          throw new Error(
            `apify source needs an actor: ${JSON.stringify(source)}`,
          );
        const raw = await runApifyActor(source.actor, source.input ?? {});
        return raw
          .map((r, i) =>
            normalizeApifyRecord(
              r,
              source.platform,
              `apify:${source.actor}#${i}`,
            ),
          )
          .filter((x): x is FeedItem => x !== null);
      }
      throw new Error(`unknown adapter "${source.adapter}"`);
    },
    describeItem,
    classifier: resolveClassifier(s),
    resolveLocation,
    createResolveDeps,
    resolveNotifier,
    appendFlagged,
    appendObservations,
    readSyncStamp,
    writeSyncStamp,
    fetchSiteReportsSince,
    reportsToObservations,
    toObservation,
  };
}

/** Structural slice of SeenStore the pipeline stages use — injectable so
 *  tests can drive the stages with recording fakes (issue #57). */
export interface SeenView {
  has(id: string): boolean;
  addAll(entries: { id: string; postedAt: string }[]): Promise<void>;
}

/**
 * THE flag rule (issue #57) — the single most load-bearing expression in the
 * repository: it decides whether a poll-line report reaches a volunteer.
 * Extracted verbatim so scripts/test-deliver.ts can pin it at its boundary:
 * `>=` flags at exactly settings.flagConfidence; flagCategories (label
 * feedback, 2026-10-18) makes press/community/delivery archive-only — the
 * dispatch signal is LINES — and an absent flagCategories falls back to
 * every category.
 */
export function shouldFlag(
  classification: Classification,
  s: Settings,
  categories: string[],
  flagCategories: string[] | undefined,
): boolean {
  return (
    classification.relevant &&
    classification.confidence >= s.flagConfidence &&
    (flagCategories ?? categories).includes(classification.category)
  );
}

/**
 * Stage 1 — ingest. Each source is independent: `Promise.allSettled` means
 * one failed source logs its failure and the run continues with the rest
 * (per-source isolation). Log lines are unchanged.
 */
export async function ingestSources(
  sources: FeedSource[],
  ingestFromSource: PipelineDeps["ingestFromSource"],
): Promise<FeedItem[]> {
  const settled = await Promise.allSettled(sources.map(ingestFromSource));
  const fetched: FeedItem[] = [];
  settled.forEach((r, i) => {
    const s = sources[i]!;
    const label = `${s.platform}/${s.handle ?? s.actor ?? "?"}`;
    if (r.status === "fulfilled") {
      console.log(`[feedflag] ${label}: ${r.value.length} items`);
      fetched.push(...r.value);
    } else {
      console.warn(
        `[feedflag] ${label} FAILED: ${String(r.reason).slice(0, 200)}`,
      );
    }
  });
  return fetched;
}

/**
 * Stage 2 — dedupe, drop seen ids, newest-first by postedAt, optional
 * sourceFilter (matches "platform/handle" or the source label), then cap at
 * opts.limit ?? settings.maxPostsPerRun. Returns the capped queue.
 */
export async function buildQueue(
  fetched: FeedItem[],
  seen: SeenView,
  opts: RunOptions,
  s: Settings,
  ignoredAuthors: string[] = [],
): Promise<FeedItem[]> {
  const ignored = new Set(
    ignoredAuthors.map((a) => a.replace(/^@/, "").toLowerCase()),
  );
  let queue = dedupeById(fetched)
    .filter((it) => !seen.has(it.id))
    .filter(
      (it) =>
        !ignored.has(it.authorHandle.replace(/^@/, "").toLowerCase()),
    )
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  if (opts.sourceFilter) {
    queue = queue.filter(
      (it) =>
        `${it.platform}/${it.authorHandle}`.includes(opts.sourceFilter!) ||
        it.source.includes(opts.sourceFilter!),
    );
  }
  queue = queue.slice(0, opts.limit ?? s.maxPostsPerRun);
  console.log(
    `[feedflag] ${queue.length} new posts to process (${fetched.length} fetched)`,
  );
  return queue;
}

/** Stage 3's injectable pieces. The resolver is created once per run by the
 *  orchestrator (createResolveDeps) and handed in, so a run shares one
 *  PizzabaseApi cache exactly as before the extraction. */
export interface DescribeClassifyDeps {
  settings: Settings;
  describeItem: PipelineDeps["describeItem"];
  classifier: DecisionProvider;
  resolveLocation: PipelineDeps["resolveLocation"];
  resolver: ResolveDeps;
}

/**
 * Stage 3 — describe (OpenRouter vision) → classify (Jev / fallback) →
 * resolve the place being discussed (issue #35 — after classify, before
 * emit) → apply the flag rule. Describe/classify failures are swallowed per
 * item (logged, item dropped); one bad item never affects the others.
 * Returns both the processed set (`done`) and the subset meeting the flag
 * rule (`flagged`).
 */
export async function describeAndClassify(
  queue: FeedItem[],
  deps: DescribeClassifyDeps,
  categories: string[],
  flagCategories: string[] | undefined,
): Promise<{ done: FlaggedItem[]; flagged: FlaggedItem[] }> {
  const flagged: FlaggedItem[] = [];
  const processed = await mapLimit(
    queue,
    deps.settings.describeConcurrency,
    async (item) => {
      const description = await deps.describeItem(item).catch((err) => {
        console.warn(
          `[feedflag] describe failed ${item.id}: ${String(err).slice(0, 150)}`,
        );
        return null;
      });
      if (!description) return null;
      const classification = await deps.classifier
        .classify(description, categories)
        .catch((err) => {
          console.warn(
            `[feedflag] classify failed ${item.id}: ${String(err).slice(0, 150)}`,
          );
          return null;
        });
      if (!classification) return null;
      // Location triangulation (issue #35): resolve the actual place the post
      // discusses. Additive (FlaggedItem.resolvedLocation); never blocks —
      // resolveLocation degrades internally, .catch is belt-and-braces.
      const resolvedLocation = await deps
        .resolveLocation(
          {
            domain: "social",
            description,
            sourceUrl: item.url ?? null,
            sourceRef: item.source,
            author: item.authorHandle,
          },
          deps.resolver,
        )
        .catch(() => NO_MATCH);
      const f: FlaggedItem = {
        item,
        description,
        classification,
        resolvedLocation,
      };
      const isFlag = shouldFlag(
        classification,
        deps.settings,
        categories,
        flagCategories,
      );
      if (isFlag) flagged.push(f);
      return f;
    },
  );
  const done = processed.filter((x): x is FlaggedItem => x !== null);
  return { done, flagged };
}

/**
 * Stage 4 — deliver: persist each flag (skipped on dryRun), notify (the
 * orchestrator passes null for dryRun/skipNotify), and log the line. Notify
 * failures are swallowed per flag — one bad delivery never sinks the run.
 */
export async function deliverFlags(
  flagged: FlaggedItem[],
  notifier: Notifier | null,
  opts: RunOptions,
  appendFlagged: PipelineDeps["appendFlagged"],
): Promise<void> {
  for (const f of flagged) {
    if (!opts.dryRun) await appendFlagged(f);
    const line =
      `🚩 ${f.item.platform}/@${f.item.authorHandle} -> ${f.classification.category} ` +
      `(${(f.classification.confidence * 100).toFixed(0)}% via ${f.classification.provider})`;
    // `runPipeline` already resolves the notifier to null under dryRun, so
    // this guard is unreachable in production. It is here because the stage is
    // now exported and separately callable: `appendFlagged` and `persistState`
    // both honour dryRun themselves, and a stage whose contract depends on its
    // caller having pre-nulled a dependency is a stage that cannot be tested
    // or reused honestly. Defence in depth, no observable behaviour change.
    if (notifier && !opts.dryRun) {
      await notifier
        .notify(f)
        .catch((err) =>
          console.warn(
            `[feedflag] notify failed: ${String(err).slice(0, 150)}`,
          ),
        );
    }
    console.log(line);
  }
}

/** Stage 5's injectable pieces. */
export type CrowdLegDeps = Pick<
  PipelineDeps,
  | "settings"
  | "readSyncStamp"
  | "fetchSiteReportsSince"
  | "reportsToObservations"
>;

/**
 * Stage 5 — crowd leg: site reports as ground-truth observations
 * (incremental). Skipped entirely when settings.pizzabaseUrl is empty — not
 * even the sync stamp is read. A fetch failure degrades to zero reports; the
 * run still completes.
 *
 * Noted, not fixed (seam PR, issue #57): persistState advances the sync
 * stamp on every non-dryRun run — including runs where the crowd fetch
 * failed or returned nothing — so site reports posted during a failed window
 * are skipped on the next run. Preserved as-is here; a future issue can make
 * the stamp conditional on a successful fetch.
 */
export async function runCrowdLeg(
  deps: CrowdLegDeps,
  opts: RunOptions,
): Promise<Observation[]> {
  if (!deps.settings.pizzabaseUrl) return [];
  const since = await deps.readSyncStamp();
  const reports = await deps
    .fetchSiteReportsSince(since, opts.limit ?? deps.settings.siteReportsMax)
    .catch((err) => {
      console.warn(`[feedflag] crowd leg failed: ${String(err).slice(0, 150)}`);
      return [];
    });
  if (!reports.length) return [];
  const crowd = await deps.reportsToObservations(
    reports,
    deps.settings.describeConcurrency,
  );
  // No Slack posting for crowd reports: they already surface via the
  // pizzabase Zapier report hooks (#feed-reports). feedflag archives them
  // to the bus + DB only (corroboration ground truth).
  console.log(
    `[feedflag] crowd leg: ${reports.length} site reports -> observations (archived; no Slack — reports already surface via #feed-reports)`,
  );
  return crowd;
}

/** Stage 6's injectable pieces. */
export type PersistDeps = Pick<
  PipelineDeps,
  "appendObservations" | "writeSyncStamp" | "toObservation"
>;

/**
 * Stage 6 — persist observations + state (location-resolved in step 3).
 * Everything is skipped on dryRun: no appendObservations, no writeSyncStamp,
 * no seen.addAll.
 */
export async function persistState(
  done: FlaggedItem[],
  crowd: Observation[],
  seen: SeenView,
  opts: RunOptions,
  deps: PersistDeps,
): Promise<void> {
  if (opts.dryRun) return;
  await deps.appendObservations([...done.map(deps.toObservation), ...crowd]);
  await deps.writeSyncStamp();
  await seen.addAll(
    done.map((f) => ({ id: f.item.id, postedAt: f.item.postedAt })),
  );
}

/**
 * One pipeline run — the thin orchestrator (issue #57): wires the production
 * defaults and calls the six stages in order. External behaviour, ordering,
 * log text, and the `{ processed, flagged }` return shape are unchanged;
 * `deps` is injectable so tests can drive a full run with recording fakes.
 */
export async function runPipeline(
  opts: RunOptions = {},
  deps: PipelineDeps = createPipelineDeps(),
): Promise<{ processed: number; flagged: number }> {
  const cfg = deps.feedsConfig;
  const s = deps.settings;
  const categories = cfg.categories;

  // 1) Ingest — each source independent; one failure shouldn't sink the run.
  const fetched = await ingestSources(cfg.sources, deps.ingestFromSource);

  // 2) Dedupe, filter seen, newest-first, cap the run.
  const seen = new SeenStore(s.dataDir);
  await seen.load();
  const queue = await buildQueue(
    fetched,
    seen,
    opts,
    s,
    cfg.ignoredAuthors ?? [],
  );

  // 3) Describe (OpenRouter vision) + classify (Jev / fallback) + resolve the
  //    place being discussed (issue #35 — after classify, before emit).
  const notifier =
    opts.skipNotify || opts.dryRun ? null : deps.resolveNotifier(s);
  const { done, flagged } = await describeAndClassify(
    queue,
    {
      settings: s,
      describeItem: deps.describeItem,
      classifier: deps.classifier,
      resolveLocation: deps.resolveLocation,
      resolver: deps.createResolveDeps(s),
    },
    categories,
    cfg.flagCategories,
  );

  // 4) Deliver + persist state + emit aggregator-ready observations.
  //    Location resolution already ran inside the mapLimit closure above
  //    (issue #35 — after classify, before emit), so `done`'s
  //    resolvedLocation feeds both the Slack place line and
  //    toObservation's additive `location.resolved` block.
  await deliverFlags(flagged, notifier, opts, deps.appendFlagged);

  // 5) Crowd leg: site reports as ground-truth observations (incremental).
  const crowd = await runCrowdLeg(deps, opts);

  // 6) Persist observations + state (location-resolved in step 3).
  await persistState(done, crowd, seen, opts, deps);

  console.log(
    `[feedflag] run complete: ${done.length} processed, ${flagged.length} flagged` +
      (opts.dryRun ? " (dry run — nothing delivered)" : ""),
  );
  return { processed: done.length, flagged: flagged.length };
}
