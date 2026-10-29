/**
 * Regression tests for config validation (issue #40 — triple helix pillar 2).
 *
 * loadFeedsConfig is the one pipeline entry point that is already
 * dependency-injectable: FEEDS_CONFIG is read from process.env at CALL time,
 * so the whole validator can be exercised against fixture files in a temp
 * dir — no repo state touched, and the original env value is restored in a
 * finally so nothing leaks into another suite.
 *
 * The contracts pinned here are load-bearing for the classifier: Jev picks
 * from `categories` and its decision cardinality caps at 255, and
 * `flagCategories` is what turns a Jev output into a Slack page — a typo'd
 * category there would silently unflag a leg (label feedback 2026-10-18:
 * the dispatch signal is LINES).
 *
 * GAP (noted for #41): positiveInt / unitInterval are private and evaluated
 * exactly once at module-import time, so their boundary behaviour (0,
 * negative, >1, non-numeric → default) cannot be pinned here without
 * mutating shared process.env before import or resetting the module
 * registry. Only their invariants are asserted through the exported
 * `settings` object below; #41's DI seams should expose the helpers
 * directly.
 *
 * Run: npx tsx scripts/test-config.ts (via npm test once #38's glob
 * discovery lands). The default-path test reads the repo's tracked
 * config/feeds.json, so run from the repo root.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadFeedsConfig, settings } from "../src/config.js";

console.log("config regression tests (issue #40)\n");

const FEEDS_KEY = "FEEDS_CONFIG";
const prevFeedsConfig = process.env[FEEDS_KEY];
const tmpRoot = mkdtempSync(join(tmpdir(), "feedflag-config-test-"));

try {
  /** Write a fixture config, point FEEDS_CONFIG at it, load it. */
  function loadFixture(name: string, cfg: unknown) {
    const path = join(tmpRoot, name);
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    process.env[FEEDS_KEY] = path;
    return loadFeedsConfig();
  }

  const ONE_SOURCE = [
    {
      platform: "instagram",
      adapter: "rsshub",
      handle: "synthetic-account",
      limit: 12,
    },
  ];

  // ---------------------------------------------------------------------------
  // Valid config — parsed shape round-trips exactly, untransformed
  // ---------------------------------------------------------------------------
  {
    const valid = {
      sources: ONE_SOURCE,
      categories: ["poll_line_report", "early_voting_info", "irrelevant"],
      flagCategories: ["poll_line_report"],
    };
    const cfg = loadFixture("valid.json", valid);
    assert.deepEqual(
      cfg,
      valid,
      "a valid config parses to the fixture shape, untransformed",
    );
    assert.equal(cfg.sources.length, 1);
    assert.deepEqual(cfg.flagCategories, ["poll_line_report"]);

    // flagCategories defaults to "all categories" when omitted.
    const noFlags = loadFixture("no-flag-categories.json", {
      sources: ONE_SOURCE,
      categories: ["poll_line_report", "irrelevant"],
    });
    assert.equal(noFlags.flagCategories, undefined);

    console.log("  ✓ valid config: shape round-trips; flagCategories optional");
  }

  // ---------------------------------------------------------------------------
  // Rejections — bad configs must fail loudly, never silently degrade
  // ---------------------------------------------------------------------------
  {
    // Zero sources — and a missing sources key lands on the same guard.
    assert.throws(
      () => loadFixture("zero-sources.json", { categories: ["a"] }),
      /No sources in .*zero-sources\.json/,
      "empty sources array is rejected, error names the file",
    );
    assert.throws(
      () =>
        loadFixture("no-sources-key.json", {
          categories: ["poll_line_report"],
        }),
      /No sources in /,
      "missing sources key is rejected too",
    );

    // Zero categories — Jev would have nothing to choose from.
    assert.throws(
      () =>
        loadFixture("zero-categories.json", {
          sources: ONE_SOURCE,
          categories: [],
        }),
      /No categories in .*zero-categories\.json/,
    );
    assert.throws(
      () => loadFixture("no-categories-key.json", { sources: ONE_SOURCE }),
      /No categories in /,
    );

    // > 255 categories: the Jev decision cardinality limit.
    const tooMany = Array.from({ length: 256 }, (_, i) =>
      `synthetic-cat-${String(i).padStart(3, "0")}`,
    );
    assert.throws(
      () =>
        loadFixture("too-many-categories.json", {
          sources: ONE_SOURCE,
          categories: tooMany,
        }),
      /categories\.length=256 > 255/,
      "256 categories is rejected with the Jev cardinality message",
    );

    // Exactly 255 is accepted — the limit is exclusive.
    const exactly255 = Array.from({ length: 255 }, (_, i) =>
      `synthetic-cat-${String(i).padStart(3, "0")}`,
    );
    const boundary = loadFixture("exactly-255-categories.json", {
      sources: ONE_SOURCE,
      categories: exactly255,
      flagCategories: ["synthetic-cat-000"],
    });
    assert.equal(boundary.categories.length, 255);

    // flagCategories must be a subset of categories — a typo'd category
    // would silently unflag a leg.
    assert.throws(
      () =>
        loadFixture("bad-flag-subset.json", {
          sources: ONE_SOURCE,
          categories: ["poll_line_report", "irrelevant"],
          flagCategories: ["poll_line_report", "not-a-real-category"],
        }),
      /flagCategories must be a subset of categories/,
    );

    // An empty flagCategories array is valid ("flag nothing").
    const emptyFlags = loadFixture("empty-flag-categories.json", {
      sources: ONE_SOURCE,
      categories: ["poll_line_report"],
      flagCategories: [],
    });
    assert.deepEqual(emptyFlags.flagCategories, []);

    // A missing config file fails at readFileSync (ENOENT), not silently.
    process.env[FEEDS_KEY] = join(tmpRoot, "does-not-exist.json");
    assert.throws(() => loadFeedsConfig(), /ENOENT/);

    console.log(
      "  ✓ rejections: zero sources/categories, >255 categories, non-subset flagCategories, missing file",
    );
  }

  // ---------------------------------------------------------------------------
  // Default path — FEEDS_CONFIG unset → ./config/feeds.json (repo-root
  // relative; run this suite from the repo root). Read-only integration pin,
  // mirroring test-govwatch.ts's config section.
  // ---------------------------------------------------------------------------
  {
    delete process.env[FEEDS_KEY]; // restored in the finally below
    const cfg = loadFeedsConfig();
    assert.ok(cfg.sources.length > 0, "the tracked feeds.json has sources");
    assert.ok(
      cfg.categories.length > 0 && cfg.categories.length <= 255,
      "the tracked feeds.json satisfies the Jev cardinality limit",
    );
    assert.ok(
      (cfg.flagCategories ?? cfg.categories).every((c) =>
        cfg.categories.includes(c),
      ),
      "the tracked feeds.json's flagCategories are a subset of categories",
    );
    console.log(
      "  ✓ default path: ./config/feeds.json loads and satisfies the validator",
    );
  }

  // ---------------------------------------------------------------------------
  // settings — invariants of the private positiveInt / unitInterval helpers
  // ---------------------------------------------------------------------------
  // GAP (see docblock): exact defaults and boundary rejections need an env
  // seam before module import; the invariants below hold in ANY environment.
  {
    // positiveInt contract: always a positive integer.
    for (const v of [
      settings.siteReportsMax,
      settings.maxPostsPerRun,
      settings.describeConcurrency,
    ]) {
      assert.ok(
        Number.isInteger(v) && v > 0,
        `positiveInt fields must be positive integers, got ${v}`,
      );
    }
    // unitInterval contract: always within [0, 1].
    assert.ok(
      settings.flagConfidence >= 0 && settings.flagConfidence <= 1,
      `flagConfidence must be a unit interval, got ${settings.flagConfidence}`,
    );
    // resolve() contract: dataDir is absolute regardless of DATA_DIR.
    assert.ok(
      isAbsolute(settings.dataDir),
      `dataDir must resolve to an absolute path, got ${settings.dataDir}`,
    );
    // URL-ish fields never carry trailing slashes (the || "" + replace contract).
    for (const u of [
      settings.rsshubUrl,
      settings.jevUrl,
      settings.zapierCatchUrl,
      settings.pizzabaseUrl,
    ]) {
      assert.ok(
        !u.endsWith("/"),
        `URL settings must not carry trailing slashes, got ${u}`,
      );
    }
    // Model defaults are always non-empty strings.
    for (const m of [settings.visionModel, settings.textModel]) {
      assert.ok(
        typeof m === "string" && m.length > 0,
        "vision/text models must always be non-empty strings",
      );
    }
    // jevModel env contract: unset → the jev-router default; set → pinned
    // verbatim ("" is meaningful — it pins the LLM fallback).
    assert.equal(
      settings.jevModel,
      process.env.JEV_MODEL === undefined
        ? "typesafe/jev-router"
        : process.env.JEV_MODEL,
      "jevModel honours the documented env contract",
    );
    // Channel splitting never yields empty entries.
    assert.ok(
      settings.slackFlagChannels.every((s) => s.length > 0),
      "slackFlagChannels must contain no empty entries",
    );
    console.log(
      "  ✓ settings: positiveInt/unitInterval invariants, path + URL contracts hold in any environment",
    );
  }
} finally {
  // Restore the caller's environment — no leakage into another suite.
  if (prevFeedsConfig === undefined) delete process.env[FEEDS_KEY];
  else process.env[FEEDS_KEY] = prevFeedsConfig;
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("\nAll config regression tests passed.");
