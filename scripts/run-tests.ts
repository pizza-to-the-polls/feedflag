/**
 * Discovery test runner (issue #38): finds every scripts/test-*.ts suite and
 * runs each in its own child process. Adding a suite becomes just adding a
 * file — package.json never changes, so a forgotten suite can no longer
 * silently stay unexercised (the hole that let PR #36 ship ~1,453 uncovered
 * lines while the test workflow stayed green).
 *
 * Isolation: each suite runs as `node --import tsx <suite>` with inherited
 * stdio, sequentially. A suite that fails — or throws at import time — is
 * reported by name, and the remaining suites still run. The final results
 * table drives the process exit code: non-zero if any suite failed.
 *
 * The glob is fixed (`scripts/test-*.ts`): the parallel triple-helix issues
 * (#39–#44) add suites by file only and rely on this shape.
 *
 * Run: npm test
 */
import { spawn } from "node:child_process";
import type { IOType } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..");
/** The discovery runner itself must never be discovered as a suite. */
const RUNNER_FILE = "run-tests.ts";
/** The shared harness is a helper, not a suite. */
const HARNESS_FILE = "test-harness.ts";
/** The discovery glob — fixed by issue #38; parallel issues rely on it. */
const SUITE_PATTERN = /^test-.+\.ts$/;

export interface SuiteResult {
  name: string;
  passed: boolean;
  /** Child exit code, or null if it was killed / failed to spawn. */
  exitCode: number | null;
  durationMs: number;
}

/**
 * Discover suites in dir: files matching test-*.ts, excluding the harness
 * and this runner, sorted lexicographically for a deterministic order.
 */
export function discoverSuites(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (f) => SUITE_PATTERN.test(f) && f !== HARNESS_FILE && f !== RUNNER_FILE,
    )
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Run one suite file in its own child process. Output is streamed (stdio
 * inherited by default); the child's exit code decides pass/fail, so a
 * suite that crashes at import time is just an ordinary failure.
 */
export function runSuite(
  file: string,
  stdio: IOType = "inherit",
): Promise<SuiteResult> {
  const name = basename(file);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        name,
        passed: exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
      });
    };
    // cwd = repo root so the `tsx` specifier in --import resolves from
    // node_modules regardless of where the runner was invoked from.
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: REPO_ROOT,
      stdio,
    });
    child.on("exit", (code) => done(code));
    child.on("error", () => done(null));
  });
}

/**
 * Run suites sequentially, in the order given; every suite runs even if an
 * earlier one failed, so a crash never hides the others' results. The
 * optional hooks let callers stream presentation around each suite.
 */
export async function runSuites(
  files: readonly string[],
  opts: {
    stdio?: IOType;
    onSuiteStart?: (name: string) => void;
    onSuiteEnd?: (result: SuiteResult) => void;
  } = {},
): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  for (const file of files) {
    opts.onSuiteStart?.(basename(file));
    const result = await runSuite(file, opts.stdio);
    opts.onSuiteEnd?.(result);
    results.push(result);
  }
  return results;
}

async function main(): Promise<void> {
  const suites = discoverSuites(import.meta.dirname);
  if (suites.length === 0) {
    console.log(
      "No test suites found in scripts/ (glob test-*.ts) — nothing to run.",
    );
    process.exit(0);
  }

  console.log(`Discovered ${suites.length} test suite(s):`);
  for (const s of suites) console.log(`  - ${basename(s)}`);
  console.log("");

  const results = await runSuites(suites, {
    onSuiteStart: (name) => {
      const rule = "─".repeat(Math.max(4, 72 - name.length));
      console.log(`── ${name} ${rule}`);
    },
    onSuiteEnd: (r) => {
      if (!r.passed) {
        const code = r.exitCode === null ? "crashed" : `exit ${r.exitCode}`;
        console.log(
          `\n  ✖ ${r.name} failed (${code}) — continuing with remaining suites\n`,
        );
      }
    },
  });

  console.log("\n── Results ──\n");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const status = r.passed ? "✓" : "✖";
    const ms = `${r.durationMs}ms`;
    console.log(`  ${status} ${r.name.padEnd(width)}  ${ms.padStart(8)}`);
  }
  const failed = results.filter((r) => !r.passed).length;
  const summary =
    failed === 0
      ? `All ${results.length} suites passed.`
      : `${results.length - failed}/${results.length} suites passed, ${failed} failed.`;
  console.log(`\n${summary}`);
  process.exit(failed === 0 ? 0 : 1);
}

// Only run when executed directly — the discovery regression tests import
// this module's helpers and must not trigger a recursive full run.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
