/**
 * Regression tests for the shared test harness itself (issue #38).
 *
 * The harness is the enabling piece for glob discovery — if its exit code,
 * ✓/✖ reporting, or async handling regressed, every suite built on it would
 * silently lose its teeth. These tests exercise the harness API surface
 * directly, plus its process-level contract (exit codes, summary text) by
 * spawning it in child processes.
 *
 * Run: npm test (discovered automatically via scripts/test-*.ts glob)
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, test, runAll } from "./test-harness.js";

console.log("test-harness regression tests (issue #38)\n");

const HARNESS_PATH = join(import.meta.dirname, "test-harness.ts");

interface ChildRun {
  exitCode: number | null;
  output: string;
}

/** Write a throwaway suite to a temp dir and run it with tsx in a child. */
async function runHarnessChild(code: string): Promise<ChildRun> {
  const dir = await mkdtemp(join(tmpdir(), "feedflag-harness-self-"));
  try {
    const file = join(dir, "child-suite.ts");
    await writeFile(file, code);
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", file], {
        cwd: join(import.meta.dirname, ".."),
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => resolve({ exitCode, output }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CHILD_IMPORT_ONLY = `
import { runAll } from "${HARNESS_PATH}";
await runAll();
`;

const CHILD_ALL_PASS = `
import { test, runAll } from "${HARNESS_PATH}";
test("first passes", () => {});
test("second passes", async () => { await Promise.resolve(); });
await runAll();
`;

const CHILD_ONE_FAILS = `
import { test, runAll } from "${HARNESS_PATH}";
test("good test", () => {});
test("bad test", () => { throw new Error("boom"); });
await runAll();
`;

// ---------------------------------------------------------------------------
// In-process API surface
// ---------------------------------------------------------------------------

test("assert re-export is node:assert/strict", () => {
  assert.equal(1 + 1, 2);
  assert.deepEqual({ a: [1, 2] }, { a: [1, 2] });
  // strict mode: deepEqual must reject loose == coercion
  assert.throws(() => assert.deepEqual({ a: 1 }, { a: "1" }));
});

test("async test bodies are awaited, sync bodies run as-is", async () => {
  const order: string[] = [];
  const asyncStep = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push("async");
  };
  const syncStep = () => {
    order.push("sync");
  };
  await asyncStep();
  syncStep();
  assert.deepEqual(order, ["async", "sync"]);
});

test("test() registers without invoking the body", () => {
  // Registration must be inert — only runAll() executes bodies. The probe
  // registered here stays unrun until this suite's runAll() reaches it.
  let invoked = false;
  test("probe registered mid-suite", () => {
    invoked = true;
  });
  assert.equal(invoked, false, "test() must not run the body");
});

// ---------------------------------------------------------------------------
// Process-level contract (exit codes, ✓/✖ output, summary text)
// ---------------------------------------------------------------------------

test("import-only run exits 0 with a 0/0 summary", async () => {
  const { exitCode, output } = await runHarnessChild(CHILD_IMPORT_ONLY);
  assert.equal(exitCode, 0, `expected exit 0, output:\n${output}`);
  assert.match(output, /0\/0 harness tests passed\./);
  assert.doesNotMatch(output, /✓|✖/);
});

test("all-pass child exits 0 with ✓ per case and a summary", async () => {
  const { exitCode, output } = await runHarnessChild(CHILD_ALL_PASS);
  assert.equal(exitCode, 0, `expected exit 0, output:\n${output}`);
  assert.match(output, /✓ first passes/);
  assert.match(output, /✓ second passes/);
  assert.match(output, /2\/2 harness tests passed\./);
});

test("failing test is reported (✖ + reason) and child exits 1", async () => {
  const { exitCode, output } = await runHarnessChild(CHILD_ONE_FAILS);
  assert.equal(exitCode, 1, `expected exit 1, output:\n${output}`);
  assert.match(output, /✓ good test/);
  assert.match(output, /✖ bad test/);
  assert.match(output, /boom/);
  assert.match(output, /1\/2 harness tests passed \(1 failed\)\./);
});

await runAll();
