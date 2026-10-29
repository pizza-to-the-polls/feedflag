/**
 * Regression tests for the pipeline's already-pure business-logic modules
 * (issue #40 — triple helix pillar 2, tests).
 *
 * Motivation: every suite before this one (workflow-crons, govwatch gates,
 * data-branch separation) covers ops and infrastructure. Not one of them
 * asserts on the pipeline's own logic — the record shape downstream
 * consumers join on (toObservation), the concurrency bound every leg relies
 * on (mapLimit), the classifier input flattening (renderInput), the
 * evidence-guard edge cases, or the util helpers. This suite pins those
 * contracts so a refactor (or a parallel PR like #36, which reshapes
 * toObservation's location block) cannot silently change what the
 * aggregator and the DB emitter see.
 *
 * Scope: only modules that are already pure or already take their inputs as
 * arguments — no src/ refactors here (that is #41's DI-seams work). Where a
 * module cannot be exercised without network or env seams, the gap is
 * documented inline and named for #41.
 *
 * PR #36 coordination: the toObservation assertions are written to hold
 * both before and after #36 lands its `location.resolved` block —
 * wait_minutes/wait_category absence is asserted outright (true in either
 * world), location is asserted "absent, or documented keys only".
 *
 * Run: npx tsx scripts/test-pipeline-pure.ts (via npm test once #38's glob
 * discovery lands)
 */
import assert from "node:assert/strict";
import { dedupeById, excerpt, mapLimit, observationId } from "../src/util.js";
import { toObservation } from "../src/emit/records.js";
import { hasGovtEvidence } from "../src/govt/evidence.js";
import { renderInput } from "../src/classify/render-input.js";
import {
  normalizeWaitText,
  type NormalizedWait,
} from "../src/normalize/wait-time.js";
import { settings } from "../src/config.js";
import type {
  Classification,
  DescriptionSet,
  FeedItem,
  FlaggedItem,
} from "../src/types.js";

console.log("pipeline pure-module regression tests (issue #40)\n");

/** One macrotask turn — enough for concurrent mapLimit workers to overlap. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// mapLimit — the concurrency primitive every fetch/describe/emit loop runs on
// ---------------------------------------------------------------------------
{
  // Bounded concurrency: at most `limit` invocations may be in flight. All
  // workers start synchronously and yield on a macrotask tick, so the
  // overlap is deterministic (no long timers, no network).
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (x) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.equal(calls, 10, "every item is processed exactly once");
  assert.ok(
    maxInFlight <= 3,
    `max in-flight ${maxInFlight} must respect the limit 3`,
  );
  assert.ok(
    maxInFlight >= 2,
    `work must actually overlap, not serialize (max in-flight ${maxInFlight})`,
  );

  // Input order is preserved even when completion order is the exact
  // reverse — the worker pool must write results by input index, not by
  // completion order.
  const resolvers: ((v: number) => void)[] = [];
  const pending = mapLimit([1, 2, 3], 3, () => {
    return new Promise<number>((resolve) => {
      resolvers.push(resolve);
    });
  });
  await tick(); // all three workers have picked their item
  assert.equal(
    resolvers.length,
    3,
    "with limit >= length every item is picked up immediately",
  );
  // Complete in reverse input order: item 3, then 2, then 1.
  resolvers[2](30);
  resolvers[1](20);
  resolvers[0](10);
  assert.deepEqual(
    await pending,
    [10, 20, 30],
    "results must line up with input positions regardless of completion order",
  );

  // Edges: empty input, limit larger than the array, and a non-positive
  // limit (clamped to 1 worker via Math.max(1, ...)) — none may hang or
  // throw, and each item is still processed exactly once.
  let emptyCalls = 0;
  const counted = async (x: number) => {
    emptyCalls++;
    return x * 2;
  };
  assert.deepEqual(await mapLimit([] as number[], 4, counted), []);
  assert.equal(emptyCalls, 0, "empty input never invokes the callback");
  const f = async (x: number) => x * 2;
  assert.deepEqual(await mapLimit([1, 2], 50, f), [2, 4]);
  assert.deepEqual(await mapLimit([1, 2, 3], 0, f), [2, 4, 6]);
  assert.deepEqual(await mapLimit([1, 2, 3], -5, f), [2, 4, 6]);

  console.log(
    "  ✓ mapLimit: bound respected, order preserved by input index, edges clamp",
  );
}

// ---------------------------------------------------------------------------
// dedupeById — the ingest-level seen-guard (first occurrence wins)
// ---------------------------------------------------------------------------
{
  const items = [
    { id: "a", n: 1 },
    { id: "b", n: 2 },
    { id: "a", n: 3 }, // duplicate — the first occurrence must win
    { id: "c", n: 4 },
  ];
  const out = dedupeById(items);
  assert.deepEqual(out, [
    { id: "a", n: 1 },
    { id: "b", n: 2 },
    { id: "c", n: 4 },
  ]);
  assert.equal(out[0], items[0], "the first occurrence is kept (by reference)");
  assert.equal(out.length, 3, "duplicates dropped, input order preserved");

  assert.deepEqual(dedupeById([]), [], "empty input");
  assert.equal(
    dedupeById([
      { id: "x", n: 1 },
      { id: "x", n: 2 },
    ]).length,
    1,
    "adjacent duplicates collapse to the first",
  );

  console.log(
    "  ✓ dedupeById: first occurrence wins, order preserved, empty input",
  );
}

// ---------------------------------------------------------------------------
// observationId — the feedback-loop reference key (Slack digests, scripts/label.ts)
// ---------------------------------------------------------------------------
{
  const base = {
    domain: "social",
    source_ref: "rsshub:instagram:synthetic-account",
    observed_at: "2026-11-02T15:04:05.000Z",
  };
  assert.equal(
    observationId(base),
    observationId({ ...base }),
    "stable across calls for identical input",
  );
  assert.match(observationId(base), /^[0-9a-f]{8}$/, "8 hex chars");

  // Each identity field participates in the hash.
  assert.notEqual(
    observationId(base),
    observationId({ ...base, domain: "govt" }),
    "differing domain → different id",
  );
  assert.notEqual(
    observationId(base),
    observationId({ ...base, source_ref: "other:source" }),
    "differing source_ref → different id",
  );
  assert.notEqual(
    observationId(base),
    observationId({ ...base, observed_at: "2026-11-02T15:04:06.000Z" }),
    "differing observed_at → different id",
  );

  // A missing source_ref is tolerated (crowd/govt refs aren't always set),
  // stable, and never conflated with an explicit empty string or a real ref.
  const noRef = { domain: "social", observed_at: base.observed_at };
  assert.match(observationId(noRef), /^[0-9a-f]{8}$/);
  assert.equal(observationId(noRef), observationId({ ...noRef }));
  assert.notEqual(observationId(noRef), observationId({ ...base }));
  assert.notEqual(
    observationId(noRef),
    observationId({
      domain: "social",
      source_ref: "",
      observed_at: base.observed_at,
    }),
  );

  console.log(
    "  ✓ observationId: stable, 8-hex, sensitive to domain/source_ref/observed_at",
  );
}

// ---------------------------------------------------------------------------
// excerpt — the caption cap every Slack digest and Jev input relies on
// ---------------------------------------------------------------------------
{
  assert.equal(
    excerpt("  a   b\t\nc  ", 100),
    "a b c",
    "runs of whitespace collapse to single spaces",
  );
  assert.equal(
    excerpt("abc", 3),
    "abc",
    "exact-length boundary: returned unchanged, no ellipsis",
  );
  assert.equal(
    excerpt("abcdef", 4),
    "abc…",
    "truncation keeps max-1 chars + the ellipsis",
  );
  assert.equal(
    excerpt("abcdef", 1),
    "…",
    "max == ellipsis width: ellipsis only",
  );
  // Degenerate max=0: slice(0, -1) keeps all but the last char. Pinned as-is
  // so a future fix is a conscious change, not an accident.
  assert.equal(excerpt("abcdef", 0), "abcde…");

  console.log(
    "  ✓ excerpt: whitespace collapse, exact boundary, truncation ellipsis, degenerate max",
  );
}

// ---------------------------------------------------------------------------
// toObservation — the aggregator-ready record shape (feedflag/observation@1)
// ---------------------------------------------------------------------------
const ITEM: FeedItem = {
  id: "post-001",
  platform: "instagram",
  authorHandle: "@synthetic-account",
  postedAt: "2026-11-02T15:04:05.000Z",
  caption: "synthetic caption for the fixture post",
  hashtags: ["#synthetic", "#fixture"],
  mediaUrls: [],
  url: "https://example.invalid/p/1",
  source: "rsshub:instagram:synthetic-account",
};
const DESCRIPTION: DescriptionSet = {
  item: ITEM,
  caption: "synthetic caption for the fixture post",
  imageDescriptions: ["synthetic image description one"],
};
const CLASSIFICATION: Classification = {
  relevant: true,
  confidence: 0.82,
  category: "poll_line_report",
  provider: "typesafe/jev-router",
};
const FLAGGED: FlaggedItem = {
  item: ITEM,
  description: DESCRIPTION,
  classification: CLASSIFICATION,
};
{
  const obs = toObservation(FLAGGED);

  // The schema literal is the aggregator's join key — it must be exact.
  assert.equal(obs.schema, "feedflag/observation@1");
  assert.equal(obs.domain, "social", "the social leg emits domain=social");

  // Every field maps from the right place on FlaggedItem.
  assert.equal(obs.source_ref, ITEM.source, "source_ref ← item.source");
  assert.equal(obs.author, ITEM.authorHandle, "author ← item.authorHandle");
  assert.equal(obs.platform, ITEM.platform, "platform ← item.platform");
  assert.equal(obs.url, ITEM.url, "url ← item.url");
  assert.equal(
    obs.posted_at,
    ITEM.postedAt,
    "posted_at copied verbatim from item.postedAt",
  );
  assert.equal(
    obs.signal_kind,
    CLASSIFICATION.category,
    "signal_kind ← classification.category",
  );
  assert.equal(obs.confidence, CLASSIFICATION.confidence);
  assert.equal(obs.provider, CLASSIFICATION.provider);
  assert.equal(obs.relevant, CLASSIFICATION.relevant);
  assert.equal(
    obs.description,
    DESCRIPTION,
    "description passed through by reference (the raw_json pattern)",
  );

  // observed_at is a valid ISO timestamp stamped at emission time.
  assert.match(
    obs.observed_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "observed_at is a UTC ISO timestamp",
  );
  assert.ok(
    Math.abs(Date.now() - Date.parse(obs.observed_at)) < 60_000,
    "observed_at is stamped now-ish",
  );

  console.log(
    "  ✓ toObservation: schema/domain pinned, every field mapped from the right source",
  );
}

// ---------------------------------------------------------------------------
// toObservation — social-leg omissions + PR #36 either-way location + D6 PII
// ---------------------------------------------------------------------------
{
  const obs = toObservation(FLAGGED);

  // The social leg only classifies — extraction fields must be ABSENT (not
  // null/0), because downstream consumers branch on their presence. True
  // before and after PR #36.
  assert.ok(!("wait_minutes" in obs), "social leg must not fill wait_minutes");
  assert.ok(
    !("wait_category" in obs),
    "social leg must not fill wait_category",
  );

  // location: either absent (pre-#36), or — once location matching lands —
  // carrying ONLY keys from the documented set. Never an unexpected key.
  const LOCATION_KEYS = ["raw", "state", "county", "precinct", "resolved"];
  const loc = obs.location as unknown as Record<string, unknown> | undefined;
  if (loc !== undefined) {
    for (const k of Object.keys(loc)) {
      assert.ok(
        LOCATION_KEYS.includes(k),
        `location must carry only documented keys, got "${k}"`,
      );
    }
    // If #36 has landed, a resolved block (when present) is a registry/
    // similarity/context match — or an explicit no-match — with a bounded
    // numeric confidence.
    const resolved = loc.resolved as Record<string, unknown> | undefined;
    if (resolved !== undefined) {
      assert.ok(
        ["registry", "similarity", "context", "no-match"].includes(
          String(resolved.method),
        ),
        `resolved.method must be a documented matcher, got ${String(resolved.method)}`,
      );
      assert.equal(
        typeof resolved.confidence,
        "number",
        "resolved.confidence must be numeric",
      );
      const c = resolved.confidence as number;
      assert.ok(
        c >= 0 && c <= 1,
        `resolved.confidence must be in 0..1, got ${c}`,
      );
    }
  }

  // D6 PII floor: toObservation whitelists fields — a contactInfo that leaks
  // into upstream data must never be lifted into the record's own fields.
  const CONTACT = { phone: "555-0100", email: "leak@example.invalid" };
  const leakyItem = { ...ITEM, contactInfo: CONTACT } as FeedItem;
  const leakyDescription = {
    ...DESCRIPTION,
    contactInfo: CONTACT,
  } as unknown as DescriptionSet;
  const leaky = toObservation({
    ...FLAGGED,
    item: leakyItem,
    description: leakyDescription,
  });
  assert.ok(!("contactInfo" in leaky), "no contactInfo key on the record");
  assert.equal(
    (leaky as Record<string, unknown>).contactInfo,
    undefined,
    "contactInfo is never lifted to the observation level",
  );
  // Strict scan of everything toObservation constructs. The description set
  // is the raw_json passthrough kept by reference for downstream debugging
  // (emit/records.ts docblock), so it is excluded here — the floor this
  // pins is that the record's OWN fields never carry contact data, in
  // either the pre- or post-#36 world.
  const surface: Record<string, unknown> = { ...leaky };
  delete surface.description;
  const flat = JSON.stringify(surface);
  assert.ok(
    !flat.includes("555-0100") && !flat.includes("leak@example.invalid"),
    `no contact data anywhere in the emitted record's own fields: ${flat}`,
  );

  console.log(
    "  ✓ toObservation: social-leg omissions, location either-way, D6 no-contactInfo",
  );
}

// ---------------------------------------------------------------------------
// hasGovtEvidence — edge cases complementary to scripts/test-data-branch.ts
// ---------------------------------------------------------------------------
// test-data-branch.ts already pins the incident shapes ({} / null / string /
// array evidence, full gated evidence). This block pins the *object-semantics*
// edges the guard's Object.keys contract implies, so a rewrite of the guard
// (e.g. to Reflect.ownKeys or a deep check) is a conscious change.
{
  // Symbol-keyed evidence: Object.keys counts own ENUMERABLE STRING keys
  // only, so a symbol-keyed block reads as empty (the shallow-keys contract).
  assert.equal(
    hasGovtEvidence({ evidence: { [Symbol("k")]: 1 } }),
    false,
    "symbol-keyed evidence has no own string keys → refused",
  );

  // Exotic object evidence with no own enumerable string keys.
  assert.equal(
    hasGovtEvidence({ evidence: new Date("2026-10-28T17:28:35Z") }),
    false,
    "Date evidence is refused (no own enumerable keys)",
  );
  assert.equal(
    hasGovtEvidence({ evidence: new Map() }),
    false,
    "Map evidence is refused (Object.keys sees no entries)",
  );

  // Inherited keys don't count — the guard is own-keys only.
  const inherited = Object.create({ method: "rest" }) as object;
  assert.equal(
    hasGovtEvidence({ evidence: inherited }),
    false,
    "inherited-only evidence is refused",
  );

  // Primitive (non-object) evidence.
  assert.equal(
    hasGovtEvidence({ evidence: 5 }),
    false,
    "number evidence fails",
  );
  assert.equal(
    hasGovtEvidence({ evidence: true }),
    false,
    "boolean evidence fails",
  );

  // The guard is shallow on the description: extra description keys are
  // ignored — only the evidence block is inspected.
  assert.equal(
    hasGovtEvidence({
      item: ITEM,
      caption: "synthetic",
      imageDescriptions: [],
      evidence: { method: "rest" },
    }),
    true,
    "a full description set with evidence passes (extra keys ignored)",
  );
  assert.equal(
    hasGovtEvidence({
      item: ITEM,
      caption: "synthetic",
      imageDescriptions: [],
    }),
    false,
    "a description set WITHOUT an evidence block fails",
  );

  console.log(
    "  ✓ evidence guard edges: exotic evidence objects, own-keys semantics, shallow description",
  );
}

// ---------------------------------------------------------------------------
// renderInput — the flattened text-only Jev input
// ---------------------------------------------------------------------------
{
  const EXPECTED_KEYS = [
    "platform",
    "author",
    "posted_at",
    "caption",
    "image_descriptions",
    "video_summary",
    "hashtags",
    "url",
  ];

  // Deterministic: identical content in different property-insertion order
  // must serialize identically (Jev sees the same string every run).
  const itemA: FeedItem = {
    id: "post-100",
    platform: "tiktok",
    authorHandle: "@synthetic-creator",
    postedAt: "2026-11-02T12:00:00.000Z",
    caption: "synthetic caption text",
    hashtags: ["#synthetic", "#fixture"],
    mediaUrls: [],
    url: "https://example.invalid/video/1",
    source: "apify:clockworks/tiktok-scraper",
  };
  const itemB: FeedItem = {
    source: "apify:clockworks/tiktok-scraper",
    mediaUrls: [],
    hashtags: ["#synthetic", "#fixture"],
    caption: "synthetic caption text",
    postedAt: "2026-11-02T12:00:00.000Z",
    authorHandle: "@synthetic-creator",
    platform: "tiktok",
    url: "https://example.invalid/video/1",
    id: "post-100",
  };
  const setA: DescriptionSet = {
    item: itemA,
    caption: "synthetic caption text",
    imageDescriptions: ["synthetic frame description"],
    videoSummary: "synthetic video summary",
  };
  const setB: DescriptionSet = {
    imageDescriptions: ["synthetic frame description"],
    videoSummary: "synthetic video summary",
    caption: "synthetic caption text",
    item: itemB,
  };
  const ra = renderInput(setA);
  const rb = renderInput(setB);
  assert.deepEqual(
    Object.keys(ra),
    EXPECTED_KEYS,
    "fixed key order (deterministic Jev input)",
  );
  assert.equal(
    JSON.stringify(ra),
    JSON.stringify(rb),
    "identical JSON regardless of input property order",
  );

  // Text-only: every value is a string, and no image payload can ride along.
  for (const [k, v] of Object.entries(ra)) {
    assert.equal(
      typeof v,
      "string",
      `${k} must be a string (Jev is text-only)`,
    );
  }
  const flat = JSON.stringify(ra);
  assert.ok(
    !flat.includes("data:image") && !flat.includes("base64"),
    "classifier input must never carry image data",
  );

  // Content mapping.
  assert.equal(ra.platform, "tiktok");
  assert.equal(ra.author, "@synthetic-creator");
  assert.equal(ra.posted_at, itemA.postedAt);
  assert.equal(ra.caption, "synthetic caption text");
  assert.equal(
    ra.image_descriptions,
    "[image 1] synthetic frame description",
    "image descriptions are numbered and newline-joined",
  );
  assert.equal(ra.video_summary, "synthetic video summary");
  assert.equal(ra.hashtags, "#synthetic #fixture", "hashtags are space-joined");
  assert.equal(ra.url, "https://example.invalid/video/1");

  // Multi-image numbering.
  const rm = renderInput({
    item: itemA,
    caption: "c",
    imageDescriptions: ["first frame", "second frame"],
  });
  assert.equal(
    rm.image_descriptions,
    "[image 1] first frame\n[image 2] second frame",
  );

  // Defaults: absent optional fields degrade to empty strings.
  const bare = renderInput({
    item: { ...itemA, url: undefined },
    caption: "c",
    imageDescriptions: [],
  });
  assert.equal(bare.video_summary, "", 'video_summary defaults to ""');
  assert.equal(bare.url, "", 'url defaults to "" when the item has none');
  assert.equal(bare.image_descriptions, "", "no images → empty string");

  // Boundary caps: caption is excerpt()ed at 4000; joined image descriptions
  // are slice-capped at 4000.
  const longCaption = renderInput({
    item: itemA,
    caption: "x".repeat(4500),
    imageDescriptions: [],
  });
  assert.equal(longCaption.caption.length, 4000);
  assert.ok(
    longCaption.caption.endsWith("…"),
    "an over-long caption is excerpted",
  );
  const exactCaption = "y".repeat(4000);
  const exactRender = renderInput({
    item: itemA,
    caption: exactCaption,
    imageDescriptions: [],
  });
  assert.equal(
    exactRender.caption,
    exactCaption,
    "a caption at the 4000-char boundary is untouched",
  );
  const bigImages = renderInput({
    item: itemA,
    caption: "c",
    imageDescriptions: ["z".repeat(5000)],
  });
  assert.equal(bigImages.image_descriptions.length, 4000);
  assert.ok(bigImages.image_descriptions.startsWith("[image 1] "));

  // GAP vs issue #40's wording: renderInput on this branch does NOT carry
  // `evidence` into the Jev input (evidence is the govt-leg audit artifact,
  // and the classifier input is text-only by design — types.ts DescriptionSet).
  // Pinned as-is; if the flattening is later extended to pass evidence
  // through, update this assertion alongside the issue wording.
  assert.ok(
    !("evidence" in ra),
    "evidence is not part of the classifier input on this branch",
  );

  console.log(
    "  ✓ renderInput: deterministic text-only flattening, boundary caps, evidence absent (gap noted)",
  );
}

// ---------------------------------------------------------------------------
// normalizeWaitText — what is testable without an LLM seam
// ---------------------------------------------------------------------------
// BLOCKER for #41 (DI seams): everything past the empty-input guard calls
// openrouterChat — normalizeWaitText has no injectable transport, so the
// LLM-side contracts (numeric strings, "20-30 min" → midpoint 25, unit
// suffixes like "65 min", "N people in line" → ~N, and the short/medium/long
// category mapping) cannot be exercised in this suite without network I/O
// or an API key. Only the pre-LLM guards and the error-degradation contract
// are pinned here; the JSON-parsing/mapping block inside the function needs
// a seam before it can be regression-tested.
{
  // Empty / whitespace-only input short-circuits BEFORE the LLM call —
  // deterministic and network-free in every environment.
  assert.deepEqual(await normalizeWaitText(""), {});
  assert.deepEqual(await normalizeWaitText("   \n\t  "), {});

  // Defensive `?.` on the raw argument (crowd-leg free text can be null-ish).
  assert.deepEqual(await normalizeWaitText(undefined as unknown as string), {});
  assert.deepEqual(await normalizeWaitText(null as unknown as string), {});

  // Error-resilience contract (the comment in wait-time.ts): when the LLM
  // call fails, the normalizer degrades to {} rather than throwing, so a
  // ground-truth report survives with wait_minutes unset. Only runnable
  // when no API key is configured — otherwise openrouterChat would perform
  // real network I/O, which this suite must never do.
  const noKey: NormalizedWait = {};
  if (settings.openrouterKey === "") {
    assert.deepEqual(
      await normalizeWaitText("20-30 min"),
      noKey,
      "no key configured → openrouterChat throws → normalizer degrades to {}",
    );
    console.log(
      "  ✓ normalizeWaitText: empty/null input short-circuits; no-key error path degrades to {}",
    );
  } else {
    // Documented conditional: OPENROUTER_API_KEY is configured in this
    // environment, so the error path cannot be reached without network I/O.
    // The empty/null guards above still ran.
    console.log(
      "  ⊘ normalizeWaitText error path: OPENROUTER_API_KEY is set in this environment; exercising it would require network I/O",
    );
  }
}

console.log("\nAll pipeline pure-module regression tests passed.");
