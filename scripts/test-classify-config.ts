/**
 * Regression tests for the injectable-settings seam (issue #41 — triple
 * helix pillar 1a).
 *
 * `loadSettings(env)` is the one pure factory behind the module-level
 * `settings` singleton: it builds the whole runtime config from a given
 * `NodeJS.ProcessEnv` instead of reading `process.env` at import time. That
 * seam is what lets `resolveClassifier`, `resolveNotifier`,
 * `createResolveDeps`, `openrouterChat` and `createLlmFallbackProvider` be
 * exercised in tests without mutating the real environment (see
 * scripts/test-classify.ts for those branches).
 *
 * The contracts pinned here are the two deliberate subtleties the issue
 * calls out, because both are load-bearing in CI:
 *
 *   - `||` (not `??`) semantics: GH Actions sets missing secrets to empty
 *     strings, and `Number("")` is `0` — so an empty-string env var must
 *     fall back to the default, never zero the flag threshold or a budget
 *     cap (positiveInt/unitInterval guard on the raw string's truthiness).
 *   - `env.JEV_MODEL === undefined` (not falsy): unset → the jev-router
 *     default, but `JEV_MODEL=""` is meaningful — it explicitly pins the
 *     LLM fallback. The same distinction applies to JEV_RESOLVE_MODEL.
 *
 * Also pinned: `settings` stays a plain mutable object (no freeze, no
 * getters, no proxy) — scripts/test-locate.ts mutates
 * `settings.resolveSlackMinConfidence` inside a `finally` to exercise the
 * notify floor, so mutability is a real dependency, not an accident.
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38).
 * Fully deterministic — every loadSettings call passes an explicit env
 * object, so nothing here depends on the host environment.
 */
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { loadSettings, settings } from "../src/config.js";

console.log("loadSettings injectable-settings regression tests (issue #41)\n");

// ---------------------------------------------------------------------------
// Defaults — an empty env object yields the documented defaults
// ---------------------------------------------------------------------------
{
  const s = loadSettings({});
  assert.equal(s.openrouterKey, "", "no key in env -> empty key string");
  assert.equal(
    s.visionModel,
    "google/gemini-2.5-flash-lite",
    "VISION_MODEL default",
  );
  assert.equal(
    s.textModel,
    "google/gemini-2.5-flash-lite",
    "TEXT_MODEL default",
  );
  assert.equal(
    s.jevModel,
    "typesafe/jev-router",
    "JEV_MODEL unset -> the jev-router default",
  );
  assert.equal(
    s.jevResolveModel,
    "typesafe/jev-router",
    "JEV_RESOLVE_MODEL unset -> mirrors the classify model",
  );
  assert.equal(s.flagConfidence, 0.7, "FLAG_CONFIDENCE default 0.7");
  assert.equal(s.maxPostsPerRun, 40, "MAX_POSTS_PER_RUN default 40");
  assert.equal(
    s.resolveSlackMinConfidence,
    0.8,
    "RESOLVE_SLACK_MIN_CONFIDENCE default 0.8",
  );
  assert.ok(
    isAbsolute(s.dataDir),
    "dataDir is resolved to an absolute path even with no DATA_DIR",
  );
  assert.deepEqual(
    s.slackFlagChannels,
    [],
    "no channels in env -> empty list (never [''])",
  );

  console.log("  ✓ empty env -> documented defaults across key fields");
}

// ---------------------------------------------------------------------------
// The `||`-not-`??` subtlety — empty strings fall back, never become 0
// ---------------------------------------------------------------------------
// GH Actions exports missing secrets as "". Number("") is 0, so a naive
// `??`-style numeric parse (or dropping positiveInt/unitInterval's raw
// truthiness guard) would zero the flag threshold and every budget cap.
{
  const emptyEnv = loadSettings({
    FLAG_CONFIDENCE: "",
    MAX_POSTS_PER_RUN: "",
    DESCRIBE_CONCURRENCY: "",
    RESOLVE_CONCURRENCY: "",
    RESOLVE_MAX_CANDIDATES: "",
    RESOLVE_LOCATIONS_LIMIT: "",
    RESOLVE_SLACK_MIN_CONFIDENCE: "",
    RESOLVE_JEV_MAX_CALLS: "",
    SITE_REPORTS_MAX: "",
  });
  assert.equal(
    emptyEnv.flagConfidence,
    0.7,
    'FLAG_CONFIDENCE="" falls back to the default, never 0',
  );
  assert.equal(
    emptyEnv.maxPostsPerRun,
    40,
    'MAX_POSTS_PER_RUN="" falls back, never 0',
  );
  assert.equal(
    emptyEnv.describeConcurrency,
    3,
    'DESCRIBE_CONCURRENCY="" falls back',
  );
  assert.equal(
    emptyEnv.resolveConcurrency,
    3,
    'RESOLVE_CONCURRENCY="" falls back',
  );
  assert.equal(
    emptyEnv.resolveMaxCandidates,
    25,
    'RESOLVE_MAX_CANDIDATES="" falls back',
  );
  assert.equal(
    emptyEnv.resolveLocationsLimit,
    5000,
    'RESOLVE_LOCATIONS_LIMIT="" falls back',
  );
  assert.equal(
    emptyEnv.resolveSlackMinConfidence,
    0.8,
    'RESOLVE_SLACK_MIN_CONFIDENCE="" falls back',
  );
  assert.equal(
    emptyEnv.resolveJevMaxCalls,
    200,
    'RESOLVE_JEV_MAX_CALLS="" falls back',
  );
  assert.equal(emptyEnv.siteReportsMax, 50, 'SITE_REPORTS_MAX="" falls back');

  // Sanity: real values still parse (the guard must not reject everything).
  const realEnv = loadSettings({
    FLAG_CONFIDENCE: "0.5",
    MAX_POSTS_PER_RUN: "12",
    RESOLVE_SLACK_MIN_CONFIDENCE: "0.9",
  });
  assert.equal(realEnv.flagConfidence, 0.5, "FLAG_CONFIDENCE=0.5 parses");
  assert.equal(realEnv.maxPostsPerRun, 12, "MAX_POSTS_PER_RUN=12 parses");
  assert.equal(
    realEnv.resolveSlackMinConfidence,
    0.9,
    "RESOLVE_SLACK_MIN_CONFIDENCE=0.9 parses",
  );

  // Out-of-range numbers fall back too (unitInterval clamps the domain).
  assert.equal(
    loadSettings({ FLAG_CONFIDENCE: "1.5" }).flagConfidence,
    0.7,
    "FLAG_CONFIDENCE=1.5 is outside [0,1] -> default",
  );
  assert.equal(
    loadSettings({ FLAG_CONFIDENCE: "abc" }).flagConfidence,
    0.7,
    "non-numeric FLAG_CONFIDENCE -> default",
  );

  console.log(
    "  ✓ empty-string env vars fall back to defaults (|| semantics, never 0)",
  );
}

// ---------------------------------------------------------------------------
// The JEV_MODEL undefined-vs-empty distinction — "" is load-bearing
// ---------------------------------------------------------------------------
{
  // Unset -> the default model.
  assert.equal(
    loadSettings({}).jevModel,
    "typesafe/jev-router",
    "JEV_MODEL unset -> default",
  );
  // Set to "" -> pins the LLM fallback (NOT the default). A falsy check
  // here would silently re-enable jev-router.
  assert.equal(
    loadSettings({ JEV_MODEL: "" }).jevModel,
    "",
    'JEV_MODEL="" is preserved verbatim (pins the LLM fallback)',
  );
  // Explicit value -> verbatim.
  assert.equal(
    loadSettings({ JEV_MODEL: "custom/jev-model" }).jevModel,
    "custom/jev-model",
    "JEV_MODEL set -> verbatim",
  );

  // JEV_RESOLVE_MODEL: unset mirrors the (possibly custom) classify model;
  // "" is again meaningful — it disables model-assisted disambiguation.
  assert.equal(
    loadSettings({ JEV_MODEL: "custom/jev-model" }).jevResolveModel,
    "custom/jev-model",
    "JEV_RESOLVE_MODEL unset -> mirrors JEV_MODEL",
  );
  assert.equal(
    loadSettings({ JEV_MODEL: "", JEV_RESOLVE_MODEL: "" }).jevResolveModel,
    "",
    'JEV_RESOLVE_MODEL="" preserved verbatim (disables disambiguation)',
  );
  assert.equal(
    loadSettings({ JEV_RESOLVE_MODEL: "resolve/only" }).jevResolveModel,
    "resolve/only",
    "JEV_RESOLVE_MODEL set -> verbatim, independent of JEV_MODEL",
  );

  console.log(
    "  ✓ JEV_MODEL/JEV_RESOLVE_MODEL: undefined -> default, empty string -> verbatim",
  );
}

// ---------------------------------------------------------------------------
// URL normalisation + channel splitting still hold under injected env
// ---------------------------------------------------------------------------
{
  const s = loadSettings({
    RSSHUB_URL: "https://rsshub.example///",
    PIZZABASE_API_URL: "https://pizzabase.example/",
    SLACK_FLAG_CHANNELS: "a, b ,, c",
  });
  assert.equal(
    s.rsshubUrl,
    "https://rsshub.example",
    "trailing slashes stripped from rsshubUrl",
  );
  assert.equal(
    s.pizzabaseUrl,
    "https://pizzabase.example",
    "trailing slash stripped from pizzabaseUrl",
  );
  assert.deepEqual(
    s.slackFlagChannels,
    ["a", "b", "c"],
    "channels split, trimmed, empties dropped",
  );

  console.log(
    "  ✓ URL trailing-slash strip + channel split hold under injected env",
  );
}

// ---------------------------------------------------------------------------
// settings stays a plain mutable object — test-locate.ts's finally-restore
// pattern depends on it (no freeze, no getters, no proxy)
// ---------------------------------------------------------------------------
{
  assert.equal(
    Object.isFrozen(settings),
    false,
    "the settings singleton must not be frozen",
  );
  const direct = loadSettings({});
  assert.ok(
    Object.getPrototypeOf(direct) === Object.prototype,
    "loadSettings returns a plain object literal (no class instance)",
  );
  const mutated = loadSettings({});
  mutated.resolveSlackMinConfidence = 0.2;
  assert.equal(
    mutated.resolveSlackMinConfidence,
    0.2,
    "a fresh Settings object is writable (test-locate's mutation pattern)",
  );
  mutated.resolveSlackMinConfidence = 0.8; // restore before any further use
  assert.equal(
    typeof mutated.flagConfidence,
    "number",
    "numeric fields stay numbers (no getter/proxy wrapping)",
  );

  console.log(
    "  ✓ settings: plain, mutable, unfrozen — the finally-restore pattern works",
  );
}

console.log("\nAll loadSettings injectable-settings tests passed.");
