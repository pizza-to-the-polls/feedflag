/**
 * Regression tests for the classify decision layer (issue #52).
 *
 * `parseJevResponse` and `composite` are the two load-bearing functions of
 * feedflag's decision layer: they decide whether a post is a poll-line
 * report and how confident we are — which is what determines whether a
 * volunteer sees a flag. Until #52 both were module-private and therefore
 * untested. TECHNICAL_DESIGN.md D5 and the module docblock both state a
 * failing decision layer must never drop a post: `parseJevResponse`'s
 * "unparseable Jev response" throw is not an error to be tolerated but the
 * *trigger* for `composite`'s degradation to the LLM fallback, and the
 * `" (jev-fallback)"` provider suffix is the audit trail recording which
 * leg produced each classification. These tests pin all four parse paths,
 * the clamping contract, the throw, and the composite's three behaviours,
 * so a refactor can never silently drop a post or launder an uncalibrated
 * LLM confidence behind an unsuffixed provider name.
 *
 * Out of scope (needs #41's injectable settings / transport seams — see the
 * BLOCKED comments at the end of this file): `resolveClassifier()`,
 * `llm-fallback.ts`, `src/describe/`.
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38)
 */
import assert from "node:assert/strict";
import { composite } from "../src/classify/index.js";
import { parseJevResponse } from "../src/classify/jev.js";
import type {
  Classification,
  DecisionProvider,
  DescriptionSet,
} from "../src/types.js";

console.log("classify decision-layer regression tests (issue #52)\n");

/** Synthetic category enum — invented for these tests, no real config read. */
const CATEGORIES = ["poll_line_report", "irrelevant", "early_voting_info"];

/** Build the Jev strict-JSON shape: {"category": <c>, "confidence": <conf>}. */
function jevJson(category: string, confidence: string): string {
  return `{"category":"${category}","confidence":${confidence}}`;
}

/** A minimal synthetic description set — shape only, no real content. */
function syntheticDescriptionSet(): DescriptionSet {
  return {
    item: {
      id: "synthetic-item-1",
      platform: "x",
      authorHandle: "@synthetic-author",
      postedAt: "2026-10-27T14:00:00Z",
      caption: "synthetic caption about a polling place",
      hashtags: [],
      mediaUrls: [],
      source: "synthetic-source",
    },
    caption: "synthetic caption about a polling place",
    imageDescriptions: [],
  };
}

/** A fresh uncalibrated fallback classification (flash-lite shape). */
function syntheticFallbackClassification(): Classification {
  return {
    relevant: false,
    confidence: 0.2,
    category: "irrelevant",
    provider: "flash-lite",
  };
}

// ---------------------------------------------------------------------------
// parseJevResponse — path 1: strict-JSON extraction
// ---------------------------------------------------------------------------
{
  const choice = parseJevResponse(
    '{"category":"poll_line_report","confidence":0.82}',
    CATEGORIES,
  );
  assert.deepEqual(
    choice,
    { category: "poll_line_report", confidence: 0.82 },
    "strict JSON with a valid category is returned as-is",
  );

  // JSON embedded in surrounding prose: the first-{ … last-} slice is still
  // parsed, so a chatty model response never falls to the lossy scan path.
  const embedded = parseJevResponse(
    'The model returned {"category":"early_voting_info","confidence":0.75} as its decision',
    CATEGORIES,
  );
  assert.deepEqual(
    embedded,
    { category: "early_voting_info", confidence: 0.75 },
    "JSON embedded in prose is still extracted via the {…} slice",
  );

  console.log(
    "  ✓ strict-JSON path: clean body and prose-embedded body both parsed",
  );
}

// ---------------------------------------------------------------------------
// parseJevResponse — path 2: category-membership validation falls through
// ---------------------------------------------------------------------------
{
  // A category not in the enum is rejected by the JSON path — it must NOT be
  // returned (a hallucinated category can never reach the emit layer) — and
  // the response falls through to the last-resort scan.
  const fellThrough = parseJevResponse(
    '{"category":"totally_fake_category","confidence":0.99} the real answer is poll_line_report 0.65',
    CATEGORIES,
  );
  assert.deepEqual(
    fellThrough,
    { category: "poll_line_report", confidence: 0.65 },
    "out-of-enum JSON category is rejected and the scan path takes over",
  );
  assert.notEqual(
    fellThrough.category,
    "totally_fake_category",
    "the hallucinated category must never be returned",
  );

  console.log(
    "  ✓ out-of-enum category is rejected and falls through to the scan path",
  );
}

// ---------------------------------------------------------------------------
// parseJevResponse — path 3: confidence clamping to the unit interval
// ---------------------------------------------------------------------------
{
  // A model that says 150% is held to certainty, not above it; below 0 is
  // held to 0. Non-numeric / non-finite / missing confidence all become 0 —
  // never NaN, which would poison every downstream threshold comparison.
  const confidenceCases = [
    {
      body: jevJson("poll_line_report", "1.5"),
      confidence: 1,
      label: "confidence > 1 clamps to 1",
    },
    {
      body: jevJson("poll_line_report", "-0.5"),
      confidence: 0,
      label: "confidence < 0 clamps to 0",
    },
    {
      body: jevJson("poll_line_report", '"not-a-number"'),
      confidence: 0,
      label: "non-numeric confidence becomes 0",
    },
    {
      body: jevJson("poll_line_report", '"Infinity"'),
      confidence: 0,
      label: "non-finite confidence becomes 0",
    },
    {
      body: '{"category":"poll_line_report"}',
      confidence: 0,
      label: "missing confidence key becomes 0",
    },
  ];
  for (const { body, confidence, label } of confidenceCases) {
    const choice = parseJevResponse(body, CATEGORIES);
    assert.equal(choice.confidence, confidence, label);
  }

  console.log("  ✓ confidence clamped to [0,1]; non-finite/missing → 0");
}

// ---------------------------------------------------------------------------
// parseJevResponse — path 4: last-resort scan (mention + float within 40 chars)
// ---------------------------------------------------------------------------
{
  const scanned = parseJevResponse(
    "the category is poll_line_report with 0.65 confidence",
    CATEGORIES,
  );
  assert.deepEqual(
    scanned,
    { category: "poll_line_report", confidence: 0.65 },
    "scan path finds a category mention plus a nearby float",
  );

  // A mention with no float nearby still yields the category — with
  // confidence 0, so the post is classified but gated by the threshold.
  const noFloat = parseJevResponse(
    "this is poll_line_report and nothing else",
    CATEGORIES,
  );
  assert.deepEqual(
    noFloat,
    { category: "poll_line_report", confidence: 0 },
    "category mention with no nearby float yields confidence 0",
  );

  // The 40-character window, at its boundary: after "poll_line_report"
  // (16 chars) the scan looks at exactly the next 40 characters.
  const justInside = parseJevResponse(
    `poll_line_report${"x".repeat(36)} 0.5`,
    CATEGORIES,
  );
  assert.equal(
    justInside.confidence,
    0.5,
    "float ending exactly at the 40-char boundary is captured",
  );
  const justOutside = parseJevResponse(
    `poll_line_report${"x".repeat(37)} 0.5`,
    CATEGORIES,
  );
  assert.equal(
    justOutside.confidence,
    0,
    "float starting beyond the 40-char window is ignored → 0",
  );

  console.log(
    "  ✓ last-resort scan: mention + float, no-float → 0, 40-char boundary",
  );
}

// ---------------------------------------------------------------------------
// parseJevResponse — path 5: total failure throws (the composite's trigger)
// ---------------------------------------------------------------------------
{
  assert.throws(
    () => parseJevResponse("asdfghjkl no structure here", CATEGORIES),
    /unparseable Jev response/,
    "no JSON, no category mention → throws with the contract message",
  );
  // The message carries the (truncated) offending body for post-incident
  // audits.
  assert.throws(
    () => parseJevResponse("qwertyuiop", CATEGORIES),
    /qwertyuiop/,
    "the error message includes the offending body",
  );

  console.log("  ✓ total garbage → throws /unparseable Jev response/");
}

// ---------------------------------------------------------------------------
// composite — passthrough: Jev healthy means the fallback is never touched
// ---------------------------------------------------------------------------
{
  const jevResult: Classification = {
    relevant: true,
    confidence: 0.82,
    category: "poll_line_report",
    provider: "fake-jev",
  };
  let fallbackCalls = 0;
  const jev: DecisionProvider = {
    name: "fake-jev",
    classify: async () => jevResult,
  };
  const fallback: DecisionProvider = {
    name: "fake-fallback",
    classify: async () => {
      fallbackCalls++;
      throw new Error("fallback must not be called when Jev succeeds");
    },
  };

  const c = composite(jev, fallback);
  assert.equal(c.name, "jev+llm-fallback");

  const result = await c.classify(syntheticDescriptionSet(), CATEGORIES);
  assert.deepEqual(result, jevResult, "Jev result returned unchanged");
  assert.equal(
    result.provider,
    "fake-jev",
    "healthy-Jev provider name is NOT suffixed",
  );
  assert.equal(
    fallbackCalls,
    0,
    "the fallback records zero calls on the happy path",
  );

  console.log("  ✓ passthrough: Jev result unchanged, fallback never called");
}

// ---------------------------------------------------------------------------
// composite — degrade: any Jev error falls back, with the audit suffix
// ---------------------------------------------------------------------------
{
  const jev: DecisionProvider = {
    name: "fake-jev",
    classify: async () => {
      throw new Error("synthetic jev transport failure");
    },
  };
  let fallbackCalls = 0;
  const fallback: DecisionProvider = {
    name: "fake-fallback",
    classify: async () => {
      fallbackCalls++;
      return syntheticFallbackClassification();
    },
  };

  const c = composite(jev, fallback);
  // The post is NOT dropped: no error escapes, the fallback's classification
  // comes back with the provider suffixed so the leg is auditable.
  const result = await c.classify(syntheticDescriptionSet(), CATEGORIES);
  assert.deepEqual(
    result,
    {
      ...syntheticFallbackClassification(),
      provider: "flash-lite (jev-fallback)",
    },
    "fallback result is returned with the (jev-fallback) audit suffix",
  );
  assert.equal(fallbackCalls, 1, "the fallback was called exactly once");
  assert.match(
    result.provider,
    /\(jev-fallback\)$/,
    "uncalibrated LLM confidence never passes unsuffixed",
  );

  console.log(
    "  ✓ degrade: any Jev throw → fallback result gets the (jev-fallback) audit suffix",
  );
}

// ---------------------------------------------------------------------------
// composite — propagate: a failing fallback must NOT be swallowed
// ---------------------------------------------------------------------------
{
  const jev: DecisionProvider = {
    name: "fake-jev",
    classify: async () => {
      throw new Error("synthetic jev failure");
    },
  };
  const fallback: DecisionProvider = {
    name: "fake-fallback",
    classify: async () => {
      throw new Error("synthetic fallback failure");
    },
  };

  const c = composite(jev, fallback);
  await assert.rejects(
    c.classify(syntheticDescriptionSet(), CATEGORIES),
    /synthetic fallback failure/,
    "when both legs fail the error propagates — composite must never return a fake classification",
  );

  console.log(
    "  ✓ propagate: fallback throwing surfaces the error (pipeline .catches upstream)",
  );
}

// ---------------------------------------------------------------------------
// composite + parseJevResponse — the integration: the parse throw exists to
// trigger the degrade
// ---------------------------------------------------------------------------
{
  const fallback: DecisionProvider = {
    name: "fake-fallback",
    classify: async () => syntheticFallbackClassification(),
  };
  // A Jev-shaped provider that runs the REAL parseJevResponse over an
  // unparseable body. The parse throw is what composite catches in
  // production; this pins why that throw is load-bearing.
  const parseShapedJev: DecisionProvider = {
    name: "fake-jev-parse",
    classify: async () => {
      const { category, confidence } = parseJevResponse(
        "garbage with no structure at all",
        CATEGORIES,
      );
      return {
        relevant: category !== "irrelevant",
        confidence,
        category,
        provider: "fake-jev-parse",
      };
    },
  };

  const c = composite(parseShapedJev, fallback);
  const result = await c.classify(syntheticDescriptionSet(), CATEGORIES);
  assert.equal(
    result.provider,
    "flash-lite (jev-fallback)",
    "an unparseable Jev body degrades to the fallback, suffixed",
  );
  assert.equal(
    result.category,
    "irrelevant",
    "fallback picked its own category",
  );

  console.log(
    "  ✓ integration: real parse throw inside a Jev-shaped provider → degrade",
  );
}

// ---------------------------------------------------------------------------
// Out of scope — blocked on #41's injectable settings / transport seams.
// Issue #42 picks these up once the seams land.
// ---------------------------------------------------------------------------

// BLOCKED(#41): resolveClassifier() reads the `settings` singleton at call
// time for its three configuration branches (Jev+fallback / fallback-only /
// throw) — untestable without injectable config.

// BLOCKED(#41): llm-fallback.ts calls openrouterChat() directly (network
// I/O) — untestable without an injectable transport.

// BLOCKED(#41): src/describe/ calls openrouterChat() and reads VISION_MODEL
// from the settings singleton — needs both the transport and config seams.

console.log("\nAll classify decision-layer regression tests passed.");
