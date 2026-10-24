/**
 * Regression tests for the scheduled cron windows in .github/workflows/*.yml.
 *
 * Motivation (issue #8): US DST ends Sunday 2026-11-01 (EDT→EST). GitHub
 * schedule crons are specified in UTC, so the social voting-hours window
 * must be bumped +1h in UTC to keep firing 7am–11pm ET local time after the
 * fall-back. These tests lock in the contract so a future DST change (spring
 * 2027) can't silently drift the poll-close coverage.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = join(import.meta.dirname, "..", ".github", "workflows");

/** One parsed cron entry from a workflow file. */
interface CronEntry {
  /** Raw cron string, e.g. "7-52/30 12-23 * * *". */
  raw: string;
  fields: string[];
  minutes: number[];
  hours: number[] | "*"; // "*" = every hour (24h schedule)
}

/** Parse a single cron expression into minute/hour sets. */
function parseCron(raw: string): CronEntry {
  const fields = raw.trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron must have 5 fields: ${raw}`);
  const [minField, hourField] = fields;

  const minutes = expandRange(minField, 0, 59);
  const hours: number[] | "*" =
    hourField === "*" ? "*" : expandRange(hourField, 0, 23);

  return { raw, fields, minutes, hours };
}

/** Expand a cron field like "7-52/30", "0-3", "12", or "*" into values. */
function expandRange(field: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    assert.ok(Number.isInteger(step) && step >= 1, `bad step in ${field}`);
    const [startStr, endStr] = range.split("-");
    const start = Number(startStr);
    const end = endStr !== undefined ? Number(endStr) : start;
    assert.ok(
      Number.isInteger(start) && Number.isInteger(end),
      `non-numeric range in ${field}`,
    );
    assert.ok(
      start >= lo && end <= hi && start <= end,
      `range ${part} outside ${lo}-${hi}`,
    );
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Extract every `- cron: "..."` entry under `on: schedule:` in a workflow file. */
function readCrons(workflow: string): CronEntry[] {
  const text = readFileSync(join(WORKFLOWS_DIR, workflow), "utf8");
  const crons: CronEntry[] = [];
  const re = /- cron:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) crons.push(parseCron(m[1]));
  assert.ok(crons.length > 0, `no schedule crons found in ${workflow}`);
  return crons;
}

/** Union of the UTC hours covered by a set of cron entries (or "*" if any is 24h). */
function coveredHours(crons: CronEntry[]): number[] | "*" {
  if (crons.some((c) => c.hours === "*")) return "*";
  const hours = new Set<number>();
  for (const c of crons) for (const h of c.hours as number[]) hours.add(h);
  return [...hours].sort((a, b) => a - b);
}

/**
 * Assert a sorted hour list forms a single contiguous arc modulo 24 (the
 * voting-hours window wraps midnight UTC, so exactly one gap — the boundary
 * between the 0-3 and 12-23 crons — may be larger than 1).
 */
function assertContiguousArc(hours: number[], label: string): void {
  const gaps: number[] = [];
  for (let i = 1; i < hours.length; i++) gaps.push(hours[i] - hours[i - 1]);
  gaps.push(hours[0] + 24 - hours[hours.length - 1]); // wrap-around gap
  const bigGaps = gaps.filter((g) => g > 1).length;
  assert.ok(
    bigGaps <= 1,
    `${label}: expected one contiguous arc (at most one boundary gap), got gaps ${gaps.join(",")}`,
  );
}

console.log("workflow-cron regression tests\n");

// ---------------------------------------------------------------------------
// feedflag.yml — social voting-hours window
// ---------------------------------------------------------------------------
{
  const workflow = "feedflag.yml";
  const crons = readCrons(workflow);
  const hours = coveredHours(crons);

  // Contract: exactly the post-bump window 12:00–03:59 UTC == 7am–11pm ET (EST).
  assert.deepEqual(
    hours,
    [0, 1, 2, 3, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    `${workflow}: UTC hour window must be 12-23 + 0-3 (bumped 2026-11-01)`,
  );
  assertContiguousArc(hours as number[], workflow);

  // Both crons fire on the same :07/:37 minute pattern (no hour fires twice or never).
  for (const c of crons) {
    assert.deepEqual(
      c.minutes,
      [7, 37],
      `${workflow}: minute pattern of "${c.raw}"`,
    );
  }

  // Local-time spot checks under EST (UTC-5, post-Nov 1): window endpoints.
  assert.equal((24 + 12 - 5) % 24, 7, "12:00 UTC == 7:00am ET after fall-back");
  assert.equal(
    (3 - 5 + 24) % 24,
    22,
    "03:00 UTC == 10:00pm ET after fall-back (window to 03:59)",
  );

  // Greppable DST provenance comment (issue #8 acceptance criterion).
  const text = readFileSync(join(WORKFLOWS_DIR, workflow), "utf8");
  assert.match(
    text,
    /bumped 2026-11-01/,
    `${workflow}: must contain greppable "bumped 2026-11-01" comment`,
  );

  console.log(
    `  ✓ ${workflow}: window 12:00–03:59 UTC (7am–11pm ET, EST), contiguous, DST comment present`,
  );
}

// ---------------------------------------------------------------------------
// feedflag-electionday.yml — runs around the clock Nov 2–4; DST-independent.
// ---------------------------------------------------------------------------
{
  const workflow = "feedflag-electionday.yml";
  const crons = readCrons(workflow);
  const hours = coveredHours(crons);

  assert.equal(hours, "*", `${workflow}: must cover all 24 UTC hours`);
  for (const c of crons) {
    assert.deepEqual(
      c.minutes,
      [11, 26, 41, 56],
      `${workflow}: 15-min minute pattern of "${c.raw}"`,
    );
  }
  console.log(
    `  ✓ ${workflow}: 24h coverage (every 15 min) — unaffected by DST`,
  );
}

// ---------------------------------------------------------------------------
// feedflag-govwatch.yml — runs 24/7; DST-independent.
// ---------------------------------------------------------------------------
{
  const workflow = "feedflag-govwatch.yml";
  const crons = readCrons(workflow);
  const hours = coveredHours(crons);

  assert.equal(hours, "*", `${workflow}: must cover all 24 UTC hours`);
  for (const c of crons) {
    assert.deepEqual(
      c.minutes,
      [13, 43],
      `${workflow}: minute pattern of "${c.raw}"`,
    );
  }
  console.log(
    `  ✓ ${workflow}: 24h coverage (every 30 min) — unaffected by DST`,
  );
}

console.log("\nAll workflow-cron regression tests passed.");
