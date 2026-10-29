/**
 * Regression tests for the govt-extraction freshness + hours gates (issue #12).
 *
 * Incident: 2026-10-26 08:13 PT the Clark NV REST path posted
 * "W Flamingo Sr Ctr: 65 min — 95%" while the county's locator card for the
 * same site (POLL_CODE 950, 6255 W. Flamingo Rd) showed
 * "Current Wait Time: N/A". The raw WAIT_TIME field had been frozen at 65
 * across every observation since the source went live (60 of 61 tracked
 * sites frozen), and the post fired 47 minutes before the site's 09:00
 * opening. These tests lock in the gate contracts so a frozen field or a
 * pre-open reading can never reach the volunteer feed at high confidence
 * again.
 *
 * Run: npm test (chained after the workflow-cron tests)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRESHNESS_FROZEN_RUNS,
  INACTIVE_TTL_MS,
  OUTSIDE_HOURS_CONFIDENCE,
  STALE_CONFIDENCE,
  freshnessConfidence,
  hoursSpecFromFields,
  isWithinHours,
  localMinutesOfDay,
  markVanishedSites,
  nextFreshness,
  parseHoursWindow,
  waitMinutesFromSeconds,
  type ReadingState,
} from "../src/govt/gates.js";

console.log("govwatch gate regression tests (issue #12)\n");

/** The Clark NV locator's posted hours for the incident site (issue #12). */
const CLARK_TZ = "America/Los_Angeles";
const CLARK_HOURS = "09:00-18:00";

// ---------------------------------------------------------------------------
// Freshness gate — a WAIT_TIME frozen across N runs is stale, not a live queue
// ---------------------------------------------------------------------------
{
  // First-ever observation of a site: nothing to compare, never stale.
  assert.deepEqual(
    nextFreshness(65, undefined),
    { frozenCount: 0, stale: false },
    "first observation resets the frozen counter",
  );

  // The incident pattern: WAIT_TIME=65 on every run. State carries
  // frozenCount forward, so the counter chains across runs.
  let prev: ReadingState | undefined = {
    minutes: 65,
    category: null,
    updated: "1793031300000",
    confidence: 0.95,
    at: "2026-10-26T15:13:00Z",
    address: "6255 W. FLAMINGO RD., LAS VEGAS",
    rawWaitTime: 65,
    lastRefresh: "1793031300000",
  };
  for (let run = 1; run < FRESHNESS_FROZEN_RUNS; run++) {
    const v = nextFreshness(65, prev);
    assert.equal(v.stale, false, `run ${run}: not yet stale`);
    assert.equal(v.frozenCount, run, `run ${run}: counter chains`);
    prev = { ...prev, minutes: 65, frozenCount: v.frozenCount };
  }
  const tripped = nextFreshness(65, prev);
  assert.equal(
    tripped.stale,
    true,
    `frozen for ${FRESHNESS_FROZEN_RUNS} consecutive runs → stale`,
  );
  assert.equal(tripped.frozenCount, FRESHNESS_FROZEN_RUNS);

  // Any change resets — a live queue that moves is fresh again.
  assert.deepEqual(
    nextFreshness(70, { minutes: 65, frozenCount: 9 }),
    { frozenCount: 0, stale: false },
    "a changed value resets the frozen counter",
  );

  // Null current value (field missing this run) resets too.
  assert.deepEqual(
    nextFreshness(null, { minutes: 65, frozenCount: 9 }),
    { frozenCount: 0, stale: false },
    "a null current value resets the frozen counter",
  );

  // Back-compat: pre-gate state files have no frozenCount — defaults to 0,
  // so the first post-deploy run starts counting from 1, not 3.
  const legacy: ReadingState = {
    minutes: 65,
    category: null,
    updated: null,
    confidence: 0.95,
    at: "2026-10-25T22:49:00Z",
  };
  assert.deepEqual(
    nextFreshness(65, legacy),
    { frozenCount: 1, stale: false },
    "legacy state (no frozenCount) defaults the counter to 0",
  );

  // Stale confidence is pinned under the evaluateReading dispatch floor (0.6)
  // — a stale reading can never dispatch even if routing changes later.
  assert.equal(
    freshnessConfidence(0.95, tripped),
    STALE_CONFIDENCE,
    "stale verdict pins confidence at STALE_CONFIDENCE",
  );
  assert.ok(
    STALE_CONFIDENCE < 0.6,
    "STALE_CONFIDENCE must sit under the 0.6 eval floor",
  );
  assert.ok(
    OUTSIDE_HOURS_CONFIDENCE < 0.6,
    "OUTSIDE_HOURS_CONFIDENCE must sit under the 0.6 eval floor",
  );
  assert.equal(
    freshnessConfidence(0.95, { frozenCount: 1, stale: false }),
    0.95,
    "fresh verdict leaves confidence untouched",
  );

  console.log(
    "  ✓ freshness gate: chains, resets, trips at N runs, confidence pinned",
  );
}

// ---------------------------------------------------------------------------
// Hours gate — the 08:13 PT incident post must be impossible
// ---------------------------------------------------------------------------
{
  const incident = new Date("2026-10-26T15:13:00Z"); // 08:13 PT (PDT, UTC-7)
  const verdict = isWithinHours(CLARK_HOURS, CLARK_TZ, incident);
  assert.equal(
    verdict.open,
    false,
    "08:13 PT is 47 minutes before the 09:00 opening — hours gate must close",
  );
  assert.match(verdict.reason ?? "", /outside hours of operation/);

  // Open boundary: 09:00 PT inclusive (16:00Z).
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-26T16:00:00Z")).open,
    true,
    "09:00 PT sharp is open (inclusive lower bound)",
  );
  // Mid-day: 13:00 PT.
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-26T20:00:00Z")).open,
    true,
    "13:00 PT is open",
  );
  // 17:59 PT open, 18:00 PT (close, exclusive) closed.
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-27T00:59:00Z")).open,
    true,
    "17:59 PT is still open",
  );
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-27T01:00:00Z")).open,
    false,
    "18:00 PT sharp is closed (exclusive upper bound)",
  );

  // DST contract: after 2026-11-01 fall-back (PST, UTC-8), 09:00 local is
  // still 09:00 local — the gate keys on the IANA zone, not UTC offsets.
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-11-03T16:59:00Z")).open,
    false,
    "post-DST: 08:59 PST closed",
  );
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-11-03T17:00:00Z")).open,
    true,
    "post-DST: 09:00 PST open",
  );

  // Midnight-crossing window ("20:00-02:00"): 23:00 open, 20:00 open,
  // 02:00 sharp closed.
  assert.equal(
    isWithinHours("20:00-02:00", CLARK_TZ, new Date("2026-10-26T06:00:00Z"))
      .open,
    true,
    "23:00 PT inside a 20:00-02:00 window is open",
  );
  assert.equal(
    isWithinHours("20:00-02:00", CLARK_TZ, new Date("2026-10-26T03:00:00Z"))
      .open,
    true,
    "20:00 PT sharp inside a 20:00-02:00 window is open",
  );
  assert.equal(
    isWithinHours("20:00-02:00", CLARK_TZ, new Date("2026-10-26T09:00:00Z"))
      .open,
    false,
    "02:00 PT sharp ends a 20:00-02:00 window",
  );

  // Fail-open contracts: bad config must never suppress live data.
  assert.equal(
    isWithinHours("garbage", CLARK_TZ, incident).open,
    true,
    "unparseable hours spec fails open",
  );
  assert.equal(
    isWithinHours("25:00-26:00", CLARK_TZ, incident).open,
    true,
    "out-of-range hours spec fails open",
  );
  assert.equal(
    isWithinHours(CLARK_HOURS, "Mars/Olympus", incident).open,
    true,
    "unknown IANA zone fails open",
  );

  // Zone math sanity.
  assert.equal(
    localMinutesOfDay(incident, CLARK_TZ),
    8 * 60 + 13,
    "localMinutesOfDay resolves the incident to 08:13 PT",
  );
  assert.equal(localMinutesOfDay(incident, "Mars/Olympus"), null);

  // Spec parser.
  assert.deepEqual(parseHoursWindow("09:00-18:00"), {
    openMin: 540,
    closeMin: 1080,
  });
  assert.deepEqual(parseHoursWindow("9:05-18:30"), {
    openMin: 545,
    closeMin: 1110,
  });
  assert.equal(parseHoursWindow("9:05-6:30 PM"), null);
  assert.equal(parseHoursWindow("any"), null);

  console.log(
    "  ✓ hours gate: incident timestamp closed, boundaries, DST, fail-open",
  );
}

// ---------------------------------------------------------------------------
// Site-removal tolerance — county adds/removes rows between runs
// ---------------------------------------------------------------------------
{
  const url =
    "https://maps.clarkcountynv.gov/arcgis/rest/services/Elections/VoteCenterWaitTimes/FeatureServer/2/query";
  const key = (code: string) => `${url}#${code}`;
  const state = (over: Partial<ReadingState>): ReadingState => ({
    minutes: 65,
    category: null,
    updated: "1793031300000",
    confidence: 0.95,
    at: new Date().toISOString(),
    address: "6255 W. FLAMINGO RD., LAS VEGAS",
    ...over,
  });

  // Clark shrank 61 → 36 mid-window: sites absent from this run's response
  // are marked inactive (kept in state), not silently deleted.
  const st: Record<string, ReadingState> = {
    [key("950")]: state({}),
    [key("931")]: state({}),
    [key("837")]: state({}),
  };
  const next: Record<string, ReadingState> = {
    [key("950")]: state({ active: true }),
    [key("931")]: state({ active: true }),
  };
  const seen = new Set([key("950"), key("931")]);
  const marked = markVanishedSites(url, st, next, seen);
  assert.deepEqual(marked, [key("837")], "vanished site is reported");
  assert.equal(
    next[key("837")]?.active,
    false,
    "vanished site kept as inactive",
  );
  assert.equal(next[key("950")]?.active, true, "seen sites stay active");

  // Already-inactive entries are kept (not re-marked) while fresh…
  const st2: Record<string, ReadingState> = {
    [key("837")]: state({
      active: false,
      at: new Date(Date.now() - 86_400_000).toISOString(),
    }),
  };
  const next2: Record<string, ReadingState> = {};
  assert.deepEqual(
    markVanishedSites(url, st2, next2, new Set<string>()),
    [],
    "inactive entries are not re-marked",
  );
  assert.ok(key("837") in next2, "fresh inactive entry is kept in state");

  // …and pruned after INACTIVE_TTL_MS.
  const st3: Record<string, ReadingState> = {
    [key("837")]: state({
      active: false,
      at: new Date(Date.now() - INACTIVE_TTL_MS - 1000).toISOString(),
    }),
  };
  const next3: Record<string, ReadingState> = {};
  markVanishedSites(url, st3, next3, new Set<string>());
  assert.ok(!(key("837") in next3), "inactive entry past TTL is pruned");

  // Other sources' state keys are never touched (prefix isolation).
  const st4: Record<string, ReadingState> = {
    ["https://other-county.example/FeatureServer/0/query#X"]: state({}),
  };
  const next4: Record<string, ReadingState> = {};
  assert.deepEqual(
    markVanishedSites(url, st4, next4, new Set<string>()),
    [],
    "other sources' keys are out of scope",
  );
  assert.ok(
    !("https://other-county.example/FeatureServer/0/query#X" in next4),
    "other sources' keys untouched",
  );

  console.log(
    "  ✓ site-removal tolerance: marked inactive, TTL-pruned, prefix-isolated",
  );
}

// ---------------------------------------------------------------------------
// Config integration — Clark carries the hours gate config; other sources
// are untouched by it
// ---------------------------------------------------------------------------
{
  const sources = readFileSync(
    join(import.meta.dirname, "..", "config", "govt-sources.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim())
    .map(
      (l) =>
        JSON.parse(l) as {
          state?: string;
          county?: string;
          graduated?: boolean;
          rest?: {
            defaultHours?: string;
            timezone?: string;
            waitSecondsField?: string;
            waitMinutesField?: string;
            openTimeField?: string;
            closeTimeField?: string;
            updatedField?: string;
            url?: string;
          };
        },
    );

  const clark = sources.find((s) => s.state === "NV");
  assert.ok(clark, "Clark NV source present");
  const clarkRest = clark.rest;
  assert.ok(clarkRest, "Clark rest config present");
  assert.equal(clarkRest.defaultHours, "09:00-18:00");
  assert.equal(clarkRest.timezone, CLARK_TZ);
  // 2026-10-29 root cause: the live wait field is WAIT_TIME_secs; the
  // WAIT_TIME minutes field is dead — it must NOT be configured anymore
  // (a configured seconds field is authoritative and exclusive).
  assert.equal(clarkRest.waitSecondsField, "WAIT_TIME_secs");
  assert.equal(
    clarkRest.waitMinutesField,
    undefined,
    "dead WAIT_TIME minutes field must not be configured",
  );
  assert.equal(clarkRest.openTimeField, "START_TIME");
  assert.equal(clarkRest.closeTimeField, "END_TIME");
  assert.equal(clarkRest.updatedField, "Last_Refresh");
  assert.equal(clark.graduated, true);
  // Election Day coverage: the query spans EV + ED groups (133 ED rows sit
  // DATE-less until Nov 3; stale EV rows that day are frozen-gate fodder).
  assert.match(
    clarkRest.url ?? "",
    /POLL_GROUP%20IN%20\(%27EV%27(,|%2C)%27ED%27\)/,
    "query covers both early-voting and election-day rows",
  );
  assert.match(
    clarkRest.url ?? "",
    /WAIT_TIME_secs/,
    "query fetches the live seconds field",
  );

  // The configured spec actually closes at the incident timestamp.
  assert.equal(
    isWithinHours(
      clarkRest.defaultHours!,
      clarkRest.timezone!,
      new Date("2026-10-26T15:13:00Z"),
    ).open,
    false,
    "Clark hours config closes the gate at the incident timestamp",
  );

  // Sources without hours config (e.g. Guilford REST) are unaffected.
  const guilford = sources.find(
    (s) =>
      s.rest?.defaultHours === undefined &&
      s.rest?.url?.includes("Early_Voting_Locations"),
  );
  assert.ok(guilford, "Guilford REST source (no hours config) present");

  console.log(
    "  ✓ config: Clark hours gate configured, other sources unaffected",
  );
}

// ---------------------------------------------------------------------------
// End-to-end gate chain on the real incident numbers — the exact sequence
// (same frozen 65 across runs, pre-open clock) must never vol-post
// ---------------------------------------------------------------------------
{
  const FLOOR = 0.6; // evaluateReading dispatch floor
  const incidentClock = new Date("2026-10-26T15:13:00Z");
  const hours = isWithinHours(CLARK_HOURS, CLARK_TZ, incidentClock);

  // Two prior runs saw 65 (frozenCount=2 in state). This run sees 65 again,
  // pre-open.
  const prev: ReadingState = {
    minutes: 65,
    category: null,
    updated: "1793031300000",
    confidence: 0.95,
    at: "2026-10-26T14:43:00Z",
    rawWaitTime: 65,
    lastRefresh: "1793031300000",
    frozenCount: 2,
  };
  const fv = nextFreshness(65, prev);
  assert.equal(fv.stale, true);
  const confidence = hours.open
    ? freshnessConfidence(0.95, fv)
    : Math.min(freshnessConfidence(0.95, fv), OUTSIDE_HOURS_CONFIDENCE);
  assert.ok(
    confidence < FLOOR,
    "incident-shaped reading (frozen + pre-open) is far under the dispatch floor",
  );

  // State round-trip: gate metadata + raw evidence survive a JSON cycle
  // (data/govt-readings.json format contract, additive over pre-gate files).
  const written: ReadingState = {
    minutes: 65,
    category: null,
    updated: "1793031300000",
    confidence,
    at: "2026-10-26T15:13:00Z",
    address: "6255 W. FLAMINGO RD., LAS VEGAS",
    rawWaitTime: 65,
    lastRefresh: "1793031300000",
    frozenCount: fv.frozenCount,
    active: true,
  };
  const read = JSON.parse(JSON.stringify(written)) as ReadingState;
  assert.equal(read.rawWaitTime, 65);
  assert.equal(read.lastRefresh, "1793031300000");
  assert.equal(read.frozenCount, 3);
  assert.equal(read.active, true);
  assert.equal(read.confidence, confidence);

  // Evidence block mirrors what the extractor attaches to observations.
  const evidence = {
    method: "rest",
    rawWaitTime: 65,
    lastRefresh: "1793031300000",
    frozenCount: fv.frozenCount,
    stale: fv.stale,
    outsideHours: !hours.open,
    hoursReason: hours.reason ?? null,
  };
  assert.equal(evidence.stale, true);
  assert.equal(evidence.outsideHours, true);
  assert.match(evidence.hoursReason ?? "", /outside hours of operation/);

  console.log(
    "  ✓ incident chain: frozen + pre-open reading stays under the dispatch floor",
  );
}

// ---------------------------------------------------------------------------
// Seconds wait field + per-site hours (issue #12 root cause, 2026-10-29)
// ---------------------------------------------------------------------------
{
  // The incident: Hend City Hall (POLL_CODE 921) card showed
  // "Approximately 60 minutes" (WAIT_TIME_secs 3600) while the dead
  // WAIT_TIME minutes field read 0 — the extractor must read secs.
  assert.equal(
    waitMinutesFromSeconds(3600),
    60,
    "3600s → 60 min (the number the county card shows)",
  );
  assert.equal(waitMinutesFromSeconds(1800), 30, "1800s → 30 min");
  assert.equal(
    waitMinutesFromSeconds(0),
    0,
    "0s → 0 min (no line is a valid reading, not a missing one)",
  );
  assert.equal(waitMinutesFromSeconds(90), 2, "90s rounds to 2 min");
  assert.equal(waitMinutesFromSeconds("3600"), 60, "string seconds parse");
  assert.equal(
    waitMinutesFromSeconds(null),
    null,
    "null secs → null — never falls back to a dead minutes field",
  );
  assert.equal(waitMinutesFromSeconds(undefined), null);
  assert.equal(waitMinutesFromSeconds(-5), null, "negative secs → null");
  assert.equal(waitMinutesFromSeconds("junk"), null, "non-numeric → null");
  assert.equal(
    waitMinutesFromSeconds(60 * 601),
    null,
    "absurd (>600 min) → null, same sanity bound as minutes fields",
  );

  // Per-site hours from Clark's 24-hour SQL time strings: Henderson City
  // Hall runs 08:00-17:00, not the 09:00-18:00 county default.
  assert.equal(
    hoursSpecFromFields("08:00:00.0000000", "17:00:00.0000000"),
    "08:00-17:00",
    "SQL time strings → HH:MM-HH:MM",
  );
  assert.equal(
    hoursSpecFromFields("08:00", "18:00"),
    "08:00-18:00",
    "plain HH:MM works too",
  );
  assert.equal(
    hoursSpecFromFields("08:00 AM", "05:00 PM"),
    null,
    "AM/PM strings rejected — a 05:00 PM close would build a bogus midnight-crossing window; fail to the default",
  );
  assert.equal(
    hoursSpecFromFields(null, "17:00:00.0000000"),
    null,
    "missing side → null (falls back to defaultHours)",
  );
  assert.equal(hoursSpecFromFields("", "17:00"), null);
  assert.equal(hoursSpecFromFields(8, 17), null, "non-strings → null");

  // Gate composition with the per-site spec, at the incident times:
  // 15:45 PT (the user's card, "Approximately 60 minutes") is inside
  // 08:00-17:00 even though the old 09:00-18:00 default would have been
  // fine here — but 08:30 PT is inside real hours while the old default
  // gated it, and 17:30 PT is outside real hours while the old default
  // let it through (posting to a closed site).
  const hendSpec = hoursSpecFromFields(
    "08:00:00.0000000",
    "17:00:00.0000000",
  );
  assert.ok(hendSpec, "Henderson spec parses");
  assert.equal(
    isWithinHours(hendSpec!, CLARK_TZ, new Date("2026-10-29T22:45:00Z")).open,
    true,
    "15:45 PT: inside 08:00-17:00 — the card's 60-min reading is postable",
  );
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-29T15:30:00Z"))
      .open,
    false,
    "08:30 PT: old default gate would wrongly suppress a pre-9am line",
  );
  assert.equal(
    isWithinHours(hendSpec!, CLARK_TZ, new Date("2026-10-30T00:30:00Z")).open,
    false,
    "17:30 PT: outside real 08:00-17:00 hours — never post to a closed site",
  );
  assert.equal(
    isWithinHours(CLARK_HOURS, CLARK_TZ, new Date("2026-10-30T00:30:00Z"))
      .open,
    true,
    "…while the old 09:00-18:00 default would have let it through",
  );

  console.log(
    "  ✓ seconds field + per-site hours: Henderson incident reads 60 min, open, dispatchable",
  );
}

console.log("\nAll govwatch gate regression tests passed.");
