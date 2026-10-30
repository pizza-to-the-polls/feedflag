/**
 * Digest db-mode regression tests (issue #69).
 *
 * `--source db` is what the bastion digest timer runs: the digest fetches
 * GET {PIZZABASE_API_URL}/feed-observations/summary instead of reading
 * data/observations.jsonl, which the runner gzips and EMPTIES after every
 * successful emit — so the file only ever holds one leg's batch, never a 26h
 * window (observed live: a "last 26h" digest posted 38 observations over a
 * window that actually contained 2,931).
 *
 * These pin the contracts the timer depends on:
 *  - the summary fetch carries since / min_confidence / flag_categories;
 *  - a window below the floor REFUSES to post (exit 1 → the runner's
 *    maybe_alert) — the digest must never look plausible over a dead
 *    pipeline, which is what exit-0-with-tiny-counts would be;
 *  - a 5xx or missing credentials exit 1 loudly, never silently;
 *  - wrong-verdict labels (the local feedback loop) are excluded;
 *  - the output carries no author/caption text (the summary endpoint is
 *    PII-free by design; if it ever starts returning them, that is a
 *    pizzabase bug we want a test to surface).
 *
 * digest.ts is a top-level script that calls process.exit, so each case runs
 * it as a child process with globalThis.fetch STUBBED via a --import preload
 * (the pizza-eagle runHelper pattern: no sockets at all — this sandbox
 * intercepts even loopback HTTP from spawned children). The preload answers
 * from a canned fixture and records the URL it was asked for. Synthetic data
 * only — example.invalid links, invented handles.
 *
 * Run: npx tsx scripts/test-digest-db.ts (discovered by the glob runner)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observationId } from "../src/util.js";

console.log("digest db-mode regression tests (issue #69)\n");

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIGEST = join(ROOT, "scripts", "digest.ts");

/** A canned SummaryResponse shaped exactly like pizzabase PR #359 returns. */
const cannedSummary = (over: Record<string, unknown> = {}) => ({
  since: "2026-10-29T22:00:00.000Z",
  total_observations: 2931,
  govt_rows: 2835,
  social_rows: 76,
  crowd_rows: 20,
  flagged_count: 6,
  hot_govt_count: 3,
  govt_source_count: 42,
  crowd_relevant_count: 20,
  by_signal_kind: [
    { kind: "wait_time_reading", count: 2835 },
    { kind: "poll_line_report", count: 6 },
    { kind: "user_report", count: 20 },
  ],
  flagged_recent: [
    {
      source_ref: "apify:clockworks/instagram-scraper#12",
      signal_kind: "poll_line_report",
      confidence: 0.92,
      url: "https://example.invalid/p/synthetic-1",
      platform: "instagram",
      observed_at: "2026-10-30T15:00:00.000Z",
    },
    {
      source_ref: "apify:clockworks/tiktok-scraper#3",
      signal_kind: "poll_line_report",
      confidence: 0.85,
      url: "https://example.invalid/p/synthetic-2",
      platform: "tiktok",
      observed_at: "2026-10-30T12:00:00.000Z",
    },
  ],
  ...over,
});

/**
 * The --import preload handed to the digest child: replaces globalThis.fetch
 * with one that answers from DIGEST_STUB_FIXTURE at DIGEST_STUB_STATUS and
 * appends every requested URL to DIGEST_STUB_CAPTURE. Written per case.
 */
const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
const fixture = process.env.DIGEST_STUB_FIXTURE;
const status = Number(process.env.DIGEST_STUB_STATUS ?? 200);
const capture = process.env.DIGEST_STUB_CAPTURE;
globalThis.fetch = async (url) => {
  if (capture) appendFileSync(capture, String(url) + "\\n");
  return new Response(readFileSync(fixture, "utf8"), {
    status,
    headers: { "content-type": "application/json" },
  });
};
`;

/** Hermetic config + labels so FLAG_CATEGORIES and feedback are ours. */
const tmp = mkdtempSync(join(tmpdir(), "ff-digest-db-"));
const CATEGORIES = ["poll_line_report", "wait_time_page_mention", "irrelevant"];
writeFileSync(
  join(tmp, "feeds.json"),
  JSON.stringify({
    sources: [
      { platform: "instagram", adapter: "apify", actor: "synthetic/actor" },
    ],
    categories: CATEGORIES,
    flagCategories: ["poll_line_report"],
  }),
);

// A wrong-verdict label for synthetic-2, so the feedback exclusion is real.
const WRONG_ID = observationId({
  source_ref: "apify:clockworks/tiktok-scraper#3",
  observed_at: "2026-10-30T12:00:00.000Z",
  domain: "social",
});
writeFileSync(
  join(tmp, "labels.jsonl"),
  JSON.stringify({ id: WRONG_ID, verdict: "wrong" }) + "\n",
);

/**
 * One digest run: fresh fixture + capture, child spawned with the preload
 * ahead of tsx. Returns exit/stdout/stderr plus every URL the stub saw.
 */
const runDigest = (
  body: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  args: string[] = ["--hours", "26", "--source", "db"],
  status = 200,
) => {
  const caseDir = mkdtempSync(join(tmpdir(), "ff-digest-case-"));
  const fixture = join(caseDir, "summary.json");
  const capture = join(caseDir, "urls.txt");
  writeFileSync(fixture, JSON.stringify(body));
  writeFileSync(join(caseDir, "preload.mjs"), PRELOAD);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      join(caseDir, "preload.mjs"),
      "--import",
      "tsx",
      DIGEST,
      ...args,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        FEEDS_CONFIG: join(tmp, "feeds.json"),
        FLAG_CONFIDENCE: "0.7",
        DATA_DIR: tmp,
        DIGEST_STUB_FIXTURE: fixture,
        DIGEST_STUB_CAPTURE: capture,
        DIGEST_STUB_STATUS: String(status),
        ...env,
      } as NodeJS.ProcessEnv,
    },
  );
  return {
    code: child.status ?? -1,
    out: child.stdout ?? "",
    err: child.stderr ?? "",
    urls: existsSync(capture)
      ? readFileSync(capture, "utf8").split("\n").filter(Boolean)
      : [],
  };
};

// Every case uses a real-looking API base so the URL parse is meaningful.
const API = "https://pizzabase.example.invalid";

{
  // Happy path: markdown digest from the summary, wrong-verdict excluded.
  const r = runDigest(cannedSummary(), {
    PIZZABASE_API_URL: API,
    PIZZABASE_API_KEY: "synthetic-key",
  });
  assert.equal(r.code, 0, `exit 0, stderr: ${r.err.slice(0, 200)}`);
  assert.match(
    r.out,
    /\*\*2931 observations\*\* \(2835 govt, 76 social, 20 crowd\)/,
    "the header counts come from the summary",
  );
  assert.match(r.out, /1 flagged/, "wrong-verdict flag excluded → 1 flagged");
  assert.ok(
    r.out.includes("example.invalid/p/synthetic-1"),
    "the surviving flag links out",
  );
  assert.ok(
    !r.out.includes("synthetic-2"),
    "the wrong-verdict flag is nowhere in the output",
  );
  assert.match(
    r.out,
    /42.* gov sources tracked — .*3 ≥60min hot now/,
    "the govt line uses source + hot counts",
  );
  assert.match(r.out, /system of record/, "the footer names the source");
  // PII floor: the flagged TABLE carries no author/caption columns. (The
  // footer's prose mentions the words "author" and "caption" when it
  // explains WHY they are absent — scope the check to the table block.)
  const tableBlock = r.out.slice(
    r.out.indexOf("### 🚩 Flagged"),
    r.out.indexOf("*Media and captions"),
  );
  assert.ok(
    !!tableBlock &&
      !/@|caption|author/.test(tableBlock.replace(/example\.invalid/g, "")),
    "the flagged table is PII-free: ids, kinds, confidences and links only",
  );
  assert.ok(
    !r.out.includes("Sample caption"),
    "db mode renders no sample-caption section",
  );
  // The query carried the caller's policy, not an invented one.
  assert.equal(r.urls.length, 1, "exactly one summary fetch");
  const q = new URL(r.urls[0] ?? "", API).searchParams;
  assert.ok(q.get("since"), "since is explicit");
  assert.equal(
    q.get("min_confidence"),
    "0.7",
    "FLAG_CONFIDENCE rides as min_confidence",
  );
  assert.equal(
    q.get("flag_categories"),
    "poll_line_report",
    "flagCategories rides, comma-joined",
  );
  assert.ok(
    r.urls[0]!.startsWith(`${API}/feed-observations/summary?`),
    "the endpoint path is the summary route",
  );

  console.log(
    "  ✓ db mode: markdown digest from the summary, labels excluded, policy params sent",
  );
}

{
  // Slack payload mode.
  const r = runDigest(
    cannedSummary(),
    { PIZZABASE_API_URL: API, PIZZABASE_API_KEY: "synthetic-key" },
    ["--hours", "26", "--source", "db", "--slack"],
  );
  assert.equal(r.code, 0, `slack exit 0, stderr: ${r.err.slice(0, 200)}`);
  const payload = JSON.parse(r.out) as { text: string };
  assert.match(payload.text, /2931 observations/);
  assert.match(
    payload.text,
    /1 social flag\(s\)/,
    "labels excluded in slack mode too",
  );
  console.log("  ✓ db mode: slack payload");
}

{
  // The floor: a dead pipeline must alert, never post a plausible digest.
  for (const [over, why] of [
    [{ total_observations: 0 }, "total outage"],
    [
      { total_observations: 0, flagged_count: 0, flagged_recent: [] },
      "outage, empty lists",
    ],
  ] as const) {
    const r = runDigest(cannedSummary(over), {
      PIZZABASE_API_URL: API,
      PIZZABASE_API_KEY: "synthetic-key",
    });
    assert.equal(r.code, 1, `${why}: exit 1`);
    assert.equal(r.out, "", `${why}: nothing posted to stdout`);
    assert.match(
      r.err,
      /below the floor/,
      `${why}: the refusal says why on stderr (→ the runner's maybe_alert)`,
    );
  }
  // The default floor is 1 — only a ZERO window refuses. A legitimately
  // quiet off-season day with a handful of observations must still post;
  // refusing there would cry wolf and train everyone to ignore the alert.
  const quiet = runDigest(
    cannedSummary({
      total_observations: 3,
      flagged_count: 0,
      flagged_recent: [],
    }),
    { PIZZABASE_API_URL: API, PIZZABASE_API_KEY: "synthetic-key" },
  );
  assert.equal(
    quiet.code,
    0,
    "3 observations posts (floor is 1, not a minimum volume)",
  );
  assert.match(quiet.out, /3 observations/);

  // The floor is configurable upward.
  const r = runDigest(cannedSummary(), {
    PIZZABASE_API_URL: API,
    PIZZABASE_API_KEY: "synthetic-key",
    DIGEST_MIN_OBSERVATIONS: "5000",
  });
  assert.equal(r.code, 1, "DIGEST_MIN_OBSERVATIONS=5000 refuses 2931");
  assert.match(r.err, /below the floor/);
  console.log(
    "  ✓ floor: zero and low windows refuse to post; the floor is configurable",
  );
}

{
  // Transport failures are loud: a 5xx, and missing credentials.
  const r = runDigest(
    { errors: ["boom"] },
    { PIZZABASE_API_URL: API, PIZZABASE_API_KEY: "synthetic-key" },
    ["--hours", "26", "--source", "db"],
    500,
  );
  assert.equal(r.code, 1, "a 500 exits 1");
  assert.match(r.err, /summary endpoint 500/);

  // Empty-string key (GH-Actions-style missing secret) → falsy → creds check fires.
  const noCreds = runDigest(cannedSummary(), {
    PIZZABASE_API_URL: API,
    PIZZABASE_API_KEY: "",
  });
  assert.equal(noCreds.code, 1, "missing creds exit 1");
  assert.match(noCreds.err, /PIZZABASE_API_URL \+ PIZZABASE_API_KEY/);
  console.log("  ✓ transport: 500 and missing creds exit 1 with a message");
}

console.log("\nAll digest db-mode regression tests passed.");
