/**
 * Regression tests for the test harness and discovery runner themselves
 * (issue #38). These lock the contracts the parallel triple-helix issues
 * (#39–#44) depend on: the `test-*.ts` glob shape, deterministic sorted
 * discovery, runner/harness self-exclusion, per-suite isolation when a
 * suite crashes at import time, non-zero exit on any failure, and the
 * harness's sync/async case handling.
 *
 * Fixtures are written to a temp dir at runtime and executed in child
 * processes exactly the way the real runner executes suites — including
 * real `tsx` children that import the real harness.
 *
 * Run: npm test (discovered automatically by scripts/run-tests.ts)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, runAll, runTests, test } from "./test-harness.js";
import { discoverSuites, runSuite, runSuites } from "./run-tests.js";

const harnessPath = join(import.meta.dirname, "test-harness.ts");
const HARNESS_URL = String(pathToFileURL(harnessPath));

/** Create a temp dir, write the given files, run fn, always clean up. */
async function withSandbox(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "feedflag-test-infra-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fixture suite that imports the real harness and calls runAll(). */
const harnessFixture = (body: string): string =>
  `import { assert, test, runAll } from ${JSON.stringify(HARNESS_URL)};\n${body}\nawait runAll();\n`;

console.log("test-harness + discovery-runner regression tests (issue #38)\n");

// ---------------------------------------------------------------------------
// Discovery: the glob is the contract every parallel issue relies on
// ---------------------------------------------------------------------------
test("discovery: test-* glob, harness/runner excluded, sorted", async () => {
  await withSandbox(
    {
      "test-b.ts": "export {};\n",
      "test-a.ts": "export {};\n",
      "test-harness.ts": "export {};\n",
      "run-tests.ts": "export {};\n",
      "helper.ts": "export {};\n",
      "tests.ts": "export {};\n",
    },
    async (dir) => {
      assert.deepEqual(
        discoverSuites(dir).map((s) => basename(s)),
        ["test-a.ts", "test-b.ts"],
        "only test-*.ts files, harness + runner excluded, sorted order",
      );
    },
  );
});

test("discovery: empty directory yields no suites", async () => {
  await withSandbox({}, async (dir) => {
    assert.deepEqual(discoverSuites(dir), []);
  });
});

// ---------------------------------------------------------------------------
// runSuite: child-process contract — exit code decides, crashes are failures
// ---------------------------------------------------------------------------
test("runSuite: passing fixture exits 0, reported passed", async () => {
  await withSandbox(
    { "test-ok.ts": 'console.log("ok");\n' },
    async (dir) => {
      const r = await runSuite(join(dir, "test-ok.ts"), "ignore");
      assert.equal(r.name, "test-ok.ts");
      assert.equal(r.passed, true);
      assert.equal(r.exitCode, 0);
      assert.ok(r.durationMs >= 0, "duration is recorded");
    },
  );
});

test("runSuite: failing fixture is reported as failed", async () => {
  await withSandbox(
    { "test-fail.ts": 'console.log("about to fail");\nprocess.exit(1);\n' },
    async (dir) => {
      const r = await runSuite(join(dir, "test-fail.ts"), "ignore");
      assert.equal(r.passed, false);
      assert.equal(r.exitCode, 1);
    },
  );
});

test("runSuite: import-time crash fails, runner survives", async () => {
  await withSandbox(
    { "test-crash.ts": 'throw new Error("boom at import time");\n' },
    async (dir) => {
      const r = await runSuite(join(dir, "test-crash.ts"), "ignore");
      assert.equal(r.passed, false, "import-time crash is a failed suite");
      assert.notEqual(r.exitCode, 0);
    },
  );
});

test("runSuites: one crashing suite never hides the others", async () => {
  await withSandbox(
    {
      "test-crash.ts": 'throw new Error("boom");\n',
      "test-good-1.ts": 'console.log("fine");\n',
      "test-good-2.ts": 'console.log("also fine");\n',
    },
    async (dir) => {
      const started: string[] = [];
      const results = await runSuites(discoverSuites(dir).reverse(), {
        stdio: "ignore",
        onSuiteStart: (name) => started.push(name),
      });
      assert.equal(
        results.length,
        3,
        "every suite gets a result, crash or not",
      );
      assert.equal(started.length, 3, "every suite was started");
      const byName = new Map(results.map((r) => [r.name, r]));
      assert.equal(byName.get("test-crash.ts")?.passed, false);
      assert.equal(byName.get("test-good-1.ts")?.passed, true);
      assert.equal(byName.get("test-good-2.ts")?.passed, true);
    },
  );
});

// ---------------------------------------------------------------------------
// Harness contract, end-to-end through real tsx children that import it
// ---------------------------------------------------------------------------
test("harness: sync + async test() bodies pass, exit 0", async () => {
  await withSandbox(
    {
      "test-happy.ts": harnessFixture(
        'test("sync math", () => { assert.equal(1 + 1, 2); });\n' +
          'test("async body", async () => {\n' +
          "  await new Promise((resolve) => setTimeout(resolve, 5));\n" +
          "  assert.ok(true);\n" +
          "});",
      ),
    },
    async (dir) => {
      const r = await runSuite(join(dir, "test-happy.ts"), "ignore");
      assert.equal(r.passed, true, `expected pass, got exit ${r.exitCode}`);
    },
  );
});

test("harness: failing test() makes runAll exit 1", async () => {
  await withSandbox(
    {
      "test-red.ts": harnessFixture(
        'test("passing case", () => { assert.ok(true); });\n' +
          'test("failing case", () => { assert.equal(1, 2, "deliberate"); });',
      ),
    },
    async (dir) => {
      const r = await runSuite(join(dir, "test-red.ts"), "ignore");
      assert.equal(
        r.passed,
        false,
        "runAll must exit non-zero when a case fails",
      );
      assert.equal(r.exitCode, 1);
    },
  );
});

test("harness: async test() rejection fails the case", async () => {
  await withSandbox(
    {
      "test-async-fail.ts": harnessFixture(
        'test("async rejection", async () => {\n' +
          "  await Promise.resolve();\n" +
          '  throw new Error("rejected");\n' +
          "});",
      ),
    },
    async (dir) => {
      const r = await runSuite(join(dir, "test-async-fail.ts"), "ignore");
      assert.equal(r.passed, false);
      assert.equal(r.exitCode, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// runTests (in-process): sequential, awaits async bodies, never throws
// ---------------------------------------------------------------------------
test("runTests: per-case results, failures don't stop later", async () => {
  const results = await runTests([
    { name: "sync pass", fn: () => {} },
    {
      name: "async pass",
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    },
    {
      name: "sync fail",
      fn: () => {
        throw new Error("nope");
      },
    },
    {
      name: "async fail",
      fn: async () => {
        throw new Error("async nope");
      },
    },
    { name: "still runs after failures", fn: () => assert.ok(true) },
  ]);
  assert.deepEqual(
    results.map((r) => [r.name, r.passed]),
    [
      ["sync pass", true],
      ["async pass", true],
      ["sync fail", false],
      ["async fail", false],
      ["still runs after failures", true],
    ],
    "order preserved, pass/fail per case",
  );
  assert.match(String(results[2]?.error), /nope/);
  assert.match(String(results[3]?.error), /async nope/);
});

await runAll();
