/**
 * emit-to-db byte-budget batching regression tests (issue #76).
 *
 * The old fixed 50-row chunks blew pizzabase's ~100kb body limit whenever
 * the row mix carried fat description blobs, tripping the 413 bisect on
 * nearly every leg — a 20-30/hr PayloadTooLargeError drumbeat in the prod
 * Lambda logs that looked like total data loss and buried real errors
 * (an operator reasonably concluded the DB was destroyed while +48k rows
 * were landing). These pin the fix:
 *
 *  - chunks are cut by serialized UTF-8 BYTES (Buffer.byteLength — .length
 *    undercounts multibyte captions) under EMIT_BYTE_BUDGET (default 90000);
 *  - the 50-row cap stays as a secondary bound;
 *  - every request the script sends fits a simulated 100kb server limit on
 *    the FIRST attempt — the drumbeat-gone proof;
 *  - the 413 bisect survives as the safety net for the one case batching
 *    cannot fix: a single row alone over the budget, reported by source_ref
 *    and skipped loudly without sinking the rows behind it.
 *
 * emit-to-db.ts runs at import only when executed directly (the run-tests.ts
 * guard), so chunkByBudget is imported directly for the pure cases; the e2e
 * cases run it as a child process with globalThis.fetch stubbed via a
 * --import preload (the test-digest-db pattern — no sockets).
 *
 * Run: npx tsx scripts/test-emit-db.ts (discovered by the glob runner)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkByBudget } from "./emit-to-db.js";

console.log("emit-to-db byte-budget batching tests (issue #76)\n");

const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** A synthetic API row of a chosen serialized size (over: extra caption bytes). */
const rowOfSize = (approxBytes: number, ref = `synthetic#${approxBytes}`) => {
  const pad = "x".repeat(Math.max(0, approxBytes - 200));
  return {
    domain: "social",
    source_ref: ref,
    url: `https://example.invalid/${ref}`,
    author: "@synthetic",
    platform: "instagram",
    observed_at: new Date().toISOString(),
    signal_kind: "poll_line_report",
    confidence: 0.9,
    provider: "synthetic",
    relevant: true,
    description: { caption: pad },
  } as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// chunkByBudget — pure
// ---------------------------------------------------------------------------
{
  // Byte-boundary split: rows that together exceed the budget are separated.
  const rows = [
    rowOfSize(40_000, "a"),
    rowOfSize(40_000, "b"),
    rowOfSize(40_000, "c"),
  ];
  const chunks = chunkByBudget(rows, 90_000, 50);
  assert.equal(chunks.length, 2, "3 x 40kb rows cannot fit one 90kb chunk");
  assert.equal(chunks[0]!.length, 2, "two 40kb rows fit together");
  assert.equal(chunks[1]!.length, 1, "the third starts a fresh chunk");
  // The exact contract the server cares about: every serialized REQUEST fits.
  for (const c of chunks) {
    const body = bytesOf({ observations: c });
    assert.ok(
      body <= 90_000,
      `serialized body ${body} must fit the 90000 budget`,
    );
  }

  // Row cap still applies even when bytes are tiny.
  const many = Array.from({ length: 120 }, (_, i) => rowOfSize(500, `r${i}`));
  const capped = chunkByBudget(many, 90_000, 50);
  assert.equal(capped.length, 3, "120 tiny rows split on the 50-row cap");
  assert.ok(
    capped.every((c) => c.length <= 50),
    "no chunk exceeds 50 rows",
  );

  // A single row over the budget is isolated, not dropped — the bisect path
  // is what reports it, so it must still be sent (and get its own chunk).
  const withFat = [rowOfSize(150_000, "fat"), rowOfSize(500, "small")];
  const fat = chunkByBudget(withFat, 90_000, 50);
  assert.equal(fat.length, 2, "an oversize row cannot share a chunk");
  assert.equal(
    fat[0]![0] && (fat[0]![0] as { source_ref: string }).source_ref,
    "fat",
    "the oversize row still gets its own chunk (bisect reports it)",
  );

  // Multibyte honesty: the budget must be respected in BYTES, not JS string
  // length. € is ONE code unit but THREE UTF-8 bytes: 50k of them are 50k
  // chars (under the 90k budget by .length — the old bug) but 150k bytes
  // (over it in bytes). A .length implementation puts the € row and the
  // "after" row in ONE chunk and the server 413s it — the exact prod
  // drumbeat this issue is about.
  const emojiRow = {
    ...rowOfSize(100, "emoji"),
    description: { caption: "€".repeat(50_000) },
  };
  assert.ok(
    bytesOf(emojiRow) > 90_000,
    "fixture check: the multibyte row is over budget in bytes",
  );
  assert.ok(
    JSON.stringify(emojiRow).length < 90_000,
    "fixture check: the same row is UNDER budget by string length — the test discriminates bytes from chars",
  );
  const emojiChunks = chunkByBudget(
    [emojiRow, rowOfSize(100, "after")],
    90_000,
    50,
  );
  assert.equal(
    emojiChunks.length,
    2,
    "byte length, not char length, bounds the chunk",
  );
  assert.ok(
    bytesOf({ observations: emojiChunks[0]! }) > 90_000,
    "a single over-budget row is sent alone so the bisect can report it",
  );
  assert.equal(
    (emojiChunks[1]![0] as { source_ref: string }).source_ref,
    "after",
    "the row behind the fat one is not blocked",
  );

  console.log(
    "  ✓ chunkByBudget: byte split, row cap, oversize isolation, multibyte",
  );
}

// ---------------------------------------------------------------------------
// e2e — the child process against a stubbed fetch (no sockets)
// ---------------------------------------------------------------------------
const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const EMIT = join(ROOT, "scripts", "emit-to-db.ts");

/** The --import preload: simulates the server's body-parser limit. */
const PRELOAD = `
import { appendFileSync } from "node:fs";
const capture = process.env.EMIT_STUB_CAPTURE;
const limit = Number(process.env.EMIT_STUB_LIMIT ?? 100000);
globalThis.fetch = async (url, options = {}) => {
  const body = String(options.body ?? "");
  if (capture) appendFileSync(capture, JSON.stringify({ url: String(url), bytes: body.length, rows: (JSON.parse(body).observations ?? []).length }) + "\\n");
  if (Buffer.byteLength(body, "utf8") > limit) {
    return new Response("PayloadTooLargeError: request entity too large", { status: 413 });
  }
  const rows = (JSON.parse(body).observations ?? []).length;
  return new Response(JSON.stringify({ inserted: rows, skipped: 0 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`;

interface Sent {
  url: string;
  bytes: number;
  rows: number;
}

const runEmit = (
  jsonl: Record<string, unknown>[],
  env: Record<string, string> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "ff-emit-"));
  writeFileSync(
    join(dir, "observations.jsonl"),
    jsonl.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  writeFileSync(join(dir, "preload.mjs"), PRELOAD);
  const capture = join(dir, "requests.jsonl");
  const child = spawnSync(
    process.execPath,
    ["--import", join(dir, "preload.mjs"), "--import", "tsx", EMIT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATA_DIR: dir,
        PIZZABASE_API_URL: "https://pizzabase.example.invalid",
        PIZZABASE_API_KEY: "synthetic-key",
        EMIT_STUB_CAPTURE: capture,
        ...env,
      } as NodeJS.ProcessEnv,
    },
  );
  const sent: Sent[] = existsSync(capture)
    ? readFileSync(capture, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Sent)
    : [];
  return {
    code: child.status ?? -1,
    out: child.stdout ?? "",
    err: child.stderr ?? "",
    sent,
  };
};

{
  // The drumbeat-gone proof: fat rows under a server that 413s >100kb.
  // Pre-#76 this sent one 120kb 3-row chunk, ate a 413, bisected twice.
  const rows = [
    rowOfSize(40_000, "a"),
    rowOfSize(40_000, "b"),
    rowOfSize(40_000, "c"),
  ];
  const r = runEmit(rows, { EMIT_STUB_LIMIT: "100000" });
  assert.equal(r.code, 0, `exit 0, stderr: ${r.err.slice(0, 200)}`);
  assert.equal(
    r.sent.length,
    2,
    "two byte-budgeted requests, not one oversized",
  );
  assert.ok(
    r.sent.every((s) => s.bytes <= 90_000),
    "every request fits the budget on the FIRST attempt",
  );
  assert.match(r.out, /3\/3 sent → inserted 3/, "all rows land");
  assert.ok(
    !r.err.includes("413") && !r.out.includes("413"),
    "no 413 anywhere — the bisect never fires in the normal path",
  );

  // The safety net: one genuinely oversize single row.
  const withFat = [rowOfSize(150_000, "fat-one"), rowOfSize(500, "small-one")];
  const f = runEmit(withFat, { EMIT_STUB_LIMIT: "100000" });
  assert.equal(f.code, 0, "a fat row is skipped loudly, not a fatal error");
  assert.match(f.out, /1\/2 sent/, "the small row still lands");
  assert.match(
    f.err,
    /413 even for a single observation/,
    "the bisect's single-row refusal still fires",
  );
  assert.match(f.err, /fat-one/, "the refusal names the row by source_ref");

  // Dry run posts nothing.
  const dryDir = mkdtempSync(join(tmpdir(), "ff-dry-"));
  writeFileSync(
    join(dryDir, "observations.jsonl"),
    rows.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  const dry = spawnSync(process.execPath, ["--import", "tsx", EMIT, "--dry"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dryDir,
      PIZZABASE_API_URL: "https://pizzabase.example.invalid",
      PIZZABASE_API_KEY: "synthetic-key",
    } as NodeJS.ProcessEnv,
  });
  assert.match(String(dry.stdout), /dry: would POST 3 observation/);
  assert.ok(!dry.stderr.includes("fetch"), "dry makes no requests");

  console.log(
    "  ✓ e2e: budgeted requests pass a 100kb server first-try; fat row safety net; dry",
  );
}

console.log("\nAll emit-to-db byte-budget tests passed.");
