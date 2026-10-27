#!/usr/bin/env node
/**
 * Regression suite for FEAT-003a: crowd wait-time reports ≥60min → #feed-lines.
 * Run via npm test. No jest — plain assert + node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_POST_MINUTES,
  isDispatchRelevantWait,
  waitReportText,
} from "../src/notify/format.js";
import type { Observation } from "../src/types.js";

// ── Fixtures (verbatim rows from data/observations.jsonl, gitignored —
//    provenance documented so a future reader sees exactly why it qualifies) ──
// Report 19092 Royal AR — the motivating case from the issue.
const ROYAL_90: Observation = {
  schema: "feedflag/observation@1",
  domain: "crowd",
  source_ref: "pizzabase:reports#19092",
  url: "https://base.polls.pizza/uploads/royal-ar-57b84f0b.mov",
  observed_at: "2026-10-27T18:30:00Z",
  location: {
    county: "Royal", // NOTE: reportsToObservations puts the CITY here
    state: "AR",
    raw: "7402 Albert Pike Rd Royal AR 71968",
  },
  signal_kind: "poll_line_report",
  wait_minutes: 90,
  wait_category: "long",
  confidence: 1,
  provider: "user",
  relevant: true,
  description: {
    item: {
      id: "19092",
      platform: "site",
      authorHandle: "crowd",
      postedAt: "2026-10-27T18:30:00Z",
      caption: "1-2 hour wait",
      hashtags: [],
      mediaUrls: [],
      source: "pizzabase-reports",
    },
    caption: "1-2 hour wait",
    imageDescriptions: [],
  },
};

// Report 18877 Brooklyn — "Less than one hour" normalizes to {0, "long"}.
// Must NOT post: it's a sub-60min report (guard for AC #2).
const BROOKLYN_LESS_THAN_ONE_HOUR: Observation = {
  schema: "feedflag/observation@1",
  domain: "crowd",
  source_ref: "pizzabase:reports#18877",
  url: "https://base.polls.pizza/uploads/brooklyn-ny-abc123.mp4",
  observed_at: "2026-10-26T14:00:00Z",
  location: {
    county: "Brooklyn",
    state: "NY",
    raw: "200 Livingston St Brooklyn NY 11201",
  },
  signal_kind: "poll_line_report",
  wait_minutes: 0,
  wait_category: "long",
  confidence: 1,
  provider: "user",
  relevant: true,
  description: {
    item: {
      id: "18877",
      platform: "site",
      authorHandle: "crowd",
      postedAt: "2026-10-26T14:00:00Z",
      caption: "Less than one hour",
      hashtags: [],
      mediaUrls: [],
      source: "pizzabase-reports",
    },
    caption: "Less than one hour",
    imageDescriptions: [],
  },
};

test("MIN_POST_MINUTES is the shared 60-minute dispatch threshold", () => {
  assert.equal(MIN_POST_MINUTES, 60);
});

test("isDispatchRelevantWait: numeric value wins when present", () => {
  assert.equal(isDispatchRelevantWait(90, "long"), true); // the Royal AR case
  assert.equal(isDispatchRelevantWait(60, "long"), true); // exact boundary
  assert.equal(isDispatchRelevantWait(30, "long"), false); // sub-threshold
  assert.equal(isDispatchRelevantWait(45, "long"), false);
  assert.equal(isDispatchRelevantWait(45, "short"), false);
  // "Less than one hour" normalizes to {0, "long"} — must NOT qualify
  assert.equal(isDispatchRelevantWait(0, "long"), false);
});

test("isDispatchRelevantWait: category-only 'long' qualifies when minutes are unparseable", () => {
  assert.equal(isDispatchRelevantWait(undefined, "long"), true);
  assert.equal(isDispatchRelevantWait(null, "long"), true);
  // undefined/missing both → no dispatch signal
  assert.equal(isDispatchRelevantWait(undefined, undefined), false);
  assert.equal(isDispatchRelevantWait(null, undefined), false);
  assert.equal(isDispatchRelevantWait(undefined, "short"), false);
  assert.equal(isDispatchRelevantWait(undefined, "medium"), false);
});

test("waitReportText: exact format for the Royal AR fixture", () => {
  const out = waitReportText(ROYAL_90);
  assert.equal(
    out,
    `:stopwatch: *Wait-time report* — Royal, AR\n` +
      `• 7402 Albert Pike Rd Royal AR 71968: 90 min (user-submitted report)\n` +
      `Source: https://base.polls.pizza/uploads/royal-ar-57b84f0b.mov`,
  );
});

test("waitReportText: city fallback when location.raw is missing", () => {
  const out = waitReportText({
    wait_minutes: 75,
    wait_category: "long",
    url: "https://base.polls.pizza/uploads/houston-tx-e1f2g3.mov",
    location: {
      county: "Houston",
      state: "TX",
      raw: undefined,
    },
  });
  assert.equal(
    out,
    `:stopwatch: *Wait-time report* — Houston, TX\n` +
      `• Houston: 75 min (user-submitted report)\n` +
      `Source: https://base.polls.pizza/uploads/houston-tx-e1f2g3.mov`,
  );
});

test("waitReportText: 'unknown' header when city/state are missing", () => {
  const out = waitReportText({
    wait_minutes: 120,
    wait_category: "long",
    url: "https://base.polls.pizza/uploads/mystery.mp4",
    location: { county: "", state: "", raw: "somewhere over the rainbow" },
  });
  assert.equal(
    out,
    `:stopwatch: *Wait-time report* — unknown\n` +
      `• somewhere over the rainbow: 120 min (user-submitted report)\n` +
      `Source: https://base.polls.pizza/uploads/mystery.mp4`,
  );
});

test("waitReportText: category-only 'long' renders as 'long' when minutes are absent", () => {
  const out = waitReportText({
    wait_minutes: undefined,
    wait_category: "long",
    url: "https://base.polls.pizza/uploads/freephxtx-4444.mov",
    location: { county: "Phoenix", state: "AZ", raw: "super long line" },
  });
  assert.equal(
    out,
    `:stopwatch: *Wait-time report* — Phoenix, AZ\n` +
      `• super long line: long (user-submitted report)\n` +
      `Source: https://base.polls.pizza/uploads/freephxtx-4444.mov`,
  );
});

test("Filtering a realistic crowd-leg batch keeps only qualifying reports", () => {
  const batch = [
    ROYAL_90,
    BROOKLYN_LESS_THAN_ONE_HOUR,
    // synthetic: 25-min report (below threshold)
    {
      ...ROYAL_90,
      wait_minutes: 25,
      wait_category: "medium" as const,
    },
    // synthetic: category-only long (no minutes)
    {
      ...ROYAL_90,
      wait_minutes: undefined,
      wait_category: "long",
    },
  ];
  const postable = batch.filter((o) =>
    isDispatchRelevantWait(o.wait_minutes, o.wait_category),
  );
  assert.equal(postable.length, 2);
  assert.equal(postable[0], ROYAL_90);
  assert.equal(postable[1].wait_minutes, undefined);
  assert.equal(postable[1].wait_category, "long");
});
