/**
 * Minimal shared test harness for scripts/test-*.ts suites (issue #38).
 *
 * House style, zero dependencies beyond Node built-ins: `test(name, fn)`
 * registers a case (sync or async), `runAll()` runs them in registration
 * order, prints the suite's ✓/✖ lines plus a summary, and process.exit(1)s
 * if anything failed. `assert` is re-exported from node:assert/strict so
 * suites keep their assert.deepEqual / assert.equal calls unchanged.
 *
 * The harness has no import-time side effects — importing it runs zero
 * code until runAll() is called, so a suite can adopt it (or not) without
 * any behaviour change.
 *
 * Usage:
 *   import { assert, test, runAll } from "./test-harness.js";
 *   test("addition", () => { assert.equal(1 + 1, 2); });
 *   test("async case", async () => { ... });
 *   await runAll();
 */
import assert from "node:assert/strict";
import process from "node:process";

export { assert };

/** A test body: sync, or an async function returning a promise. */
export type TestFn = () => void | Promise<void>;

/** A single registered test case. */
export interface TestCase {
  name: string;
  fn: TestFn;
}

/** Outcome of one executed test case. */
export interface TestResult {
  name: string;
  passed: boolean;
  /** Error thrown by a failed case (absent when passed). */
  error?: unknown;
  durationMs: number;
}

const registered: TestCase[] = [];

/** Register a test case. Registration only — nothing runs until runAll(). */
export function test(name: string, fn: TestFn): void {
  registered.push({ name, fn });
}

/** Milliseconds elapsed since startedAt (per-case duration). */
const elapsed = (startedAt: number): number => Date.now() - startedAt;

/**
 * Run the given cases sequentially, awaiting async bodies, and never
 * throwing — a failure is captured on its case so later cases still run.
 */
export async function runTests(
  cases: readonly TestCase[],
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const { name, fn } of cases) {
    const startedAt = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: elapsed(startedAt) });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error,
        durationMs: elapsed(startedAt),
      });
    }
  }
  return results;
}

/**
 * Run every registered case, print ✓/✖ per case plus a final summary, and
 * process.exit(1) if any case failed (a failing suite can never exit 0 —
 * that is the whole point). Returns the results on success.
 */
export async function runAll(): Promise<TestResult[]> {
  const results = await runTests(registered);
  let failed = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
    } else {
      failed++;
      console.log(`  ✖ ${r.name}`);
      console.log(indentStack(r.error));
    }
  }
  if (failed > 0) {
    console.log(
      `\n${results.length - failed}/${results.length} harness tests passed (${failed} failed).`,
    );
    process.exit(1);
  }
  console.log(`\n${results.length}/${results.length} harness tests passed.`);
  return results;
}

/** Indent an error's stack/message so it sits under its ✖ line. */
function indentStack(error: unknown): string {
  const text =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}
