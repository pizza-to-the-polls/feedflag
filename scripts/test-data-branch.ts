/**
 * Regression tests for the issue-#20 data-branch fixes.
 *
 * Incident: 2026-10-28 17:28:35 UTC the govwatch GitHub Actions backup ran
 * PRE-GATE code checked out from the stale `data` branch (merge-base with
 * main = 2026-10-24, before PR #16 landed the freshness/hours gates) and
 * re-posted the frozen Clark NV waits to the volunteer feed at 95%
 * confidence with an empty description — exactly the failure mode the
 * issue-#12 gates exist to prevent. The bastion's gated runs at 17:03/17:20/
 * 17:34 had flagged those same readings stale=true, frozen_run(s)=44-47,
 * confidence 0.2, and withheld them.
 *
 * Three contracts are locked in here:
 *  1. Evidence guard (src/govt/evidence.ts): an empty evidence block — the
 *     pre-gate-code signature — is refused by BOTH ends of the govt
 *     observation path (writer + DB emitter), and gated evidence passes.
 *  2. Workflow separation: every state-persisting workflow checks out MAIN
 *     for code, overlays only state files from refs/heads/data, and pushes
 *     state via ops/state-push.sh — no rebase, no whole-checkout pushes.
 *  3. ops/state-push.sh + scripts/reconcile-data-branch.sh are
 *     plumbing-only: no branch switching, no working-tree rebase, and the
 *     reconcile is force-with-lease.
 *
 * Run: npm test (chained after the cron + gate tests)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasGovtEvidence } from "../src/govt/evidence.js";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

console.log("data-branch separation regression tests (issue #20)\n");

// ---------------------------------------------------------------------------
// Evidence guard — the pre-gate signature must be refused, gated evidence passes
// ---------------------------------------------------------------------------
{
  // The 2026-10-28 17:28:35 incident rows (feed_observations ids
  // 141464/141468/141471/141473) carried description = {} — the pre-gate
  // signature; gated rows carry full "REST field evidence".
  assert.equal(
    hasGovtEvidence({}),
    false,
    "description: {} (the incident signature) must fail the guard",
  );
  assert.equal(hasGovtEvidence(undefined), false, "missing description fails");
  assert.equal(hasGovtEvidence(null), false, "null description fails");
  assert.equal(
    hasGovtEvidence("caption"),
    false,
    "non-object description fails",
  );
  assert.equal(
    hasGovtEvidence({ evidence: {} }),
    false,
    "empty evidence object fails",
  );
  assert.equal(hasGovtEvidence({ evidence: null }), false);
  assert.equal(
    hasGovtEvidence({ evidence: [] }),
    false,
    "array evidence fails",
  );
  assert.equal(
    hasGovtEvidence({ evidence: "REST field evidence: wait=65" }),
    false,
    "string evidence fails",
  );

  // A gated observation (PR #16 signature) passes — full REST field evidence.
  const gatedDescription = {
    item: {
      id: "https://maps.clarkcountynv.gov/arcgis/rest/services/Elections/VoteCenterWaitTimes/FeatureServer/2/query#950",
      platform: "site",
      authorHandle: "NV Voting Centers",
      postedAt: "2026-10-28T17:28:35.305Z",
      caption: "Govt wait-time reading — NV Clark",
      hashtags: [],
      mediaUrls: [],
      source: "govt-extraction:rest",
    },
    caption:
      "REST field evidence: wait=65, last_refresh=1793212201000, frozen_run(s)=3, " +
      "stale=true, outside_hours=false",
    imageDescriptions: [],
    evidence: {
      method: "rest",
      rawWaitTime: 65,
      lastRefresh: "1793212201000",
      frozenCount: 3,
      stale: true,
      outsideHours: false,
      hoursReason: null,
      sourceUrl:
        "https://maps.clarkcountynv.gov/arcgis/rest/services/Elections/VoteCenterWaitTimes/FeatureServer/2/query",
    },
  };
  assert.equal(
    hasGovtEvidence(gatedDescription),
    true,
    "gated observation (full REST evidence) passes",
  );

  // The guard is presence-based, not REST-field-based: a text-extraction
  // reading with null raw fields but a real evidence block passes.
  assert.equal(
    hasGovtEvidence({
      evidence: { method: "text", rawWaitTime: null, frozenCount: 0 },
    }),
    true,
    "text-extraction evidence passes (presence check, not REST-field check)",
  );
  assert.equal(
    hasGovtEvidence({ evidence: { method: "rest" } }),
    true,
    "any non-empty evidence object passes",
  );

  console.log(
    "  ✓ evidence guard: pre-gate signature refused, gated evidence passes",
  );
}

// ---------------------------------------------------------------------------
// Guard wired at BOTH ends of the govt observation path
// ---------------------------------------------------------------------------
{
  const writer = read("scripts/extract-wait-times.ts");
  const emitter = read("scripts/emit-to-db.ts");
  assert.match(
    writer,
    /hasGovtEvidence/,
    "writer (extract-wait-times.ts) must refuse evidenceless govt rows",
  );
  assert.match(
    emitter,
    /hasGovtEvidence/,
    "DB emitter (emit-to-db.ts) must refuse evidenceless govt rows",
  );
  assert.match(
    emitter,
    /domain === "govt"/,
    "emitter guard must key on the govt domain only",
  );
  console.log("  ✓ guard wired at the writer and the DB emitter");
}

// ---------------------------------------------------------------------------
// Workflows: code from main, state overlaid from the data branch, state-only pushes
// ---------------------------------------------------------------------------
{
  const workflows: { file: string; state: string[] }[] = [
    {
      file: "feedflag-govwatch.yml",
      state: ["data/govt-readings.json", "data/observations.jsonl"],
    },
    {
      file: "feedflag-electionday.yml",
      state: ["data/govt-readings.json", "data/observations.jsonl"],
    },
    {
      file: "feedflag.yml",
      state: [
        "data/seen.json",
        "data/flagged.jsonl",
        "data/observations.jsonl",
        "data/reports-sync.json",
        "data/labels.jsonl",
        "data/govt-readings.json",
      ],
    },
  ];

  for (const { file, state } of workflows) {
    const text = read(`.github/workflows/${file}`);
    // 1. Code NEVER comes from the data branch. Prose comments (e.g. the
    //    issue-#20 history note) may legitimately mention `ref: data` —
    //    the assertion is about the YAML checkout step, so strip
    //    full-line comments before pattern-matching.
    const yaml = text.replace(/^[ \t]*#.*$/gm, "");
    assert.doesNotMatch(
      yaml,
      /ref:\s*data\b/,
      `${file}: must not check out the data branch for code (issue #20)`,
    );
    assert.match(
      text,
      /ref:\s*main\b/,
      `${file}: must check out main for code`,
    );
    // 2. State is overlaid from the data branch at boot — every whitelisted
    //    file the workflow persists must also be restored.
    assert.match(
      text,
      /git fetch .*refs\/heads\/data/,
      `${file}: must fetch refs/heads/data for state restore`,
    );
    assert.match(
      text,
      /git checkout .*FETCH_HEAD/,
      `${file}: must overlay state files from the data tip`,
    );
    for (const f of state) {
      assert.ok(
        text.includes(f),
        `${file}: state file ${f} must be listed in restore + persist whitelists`,
      );
    }
    // 3. State pushes go through the plumbing helper — never a whole-checkout
    //    push or a working-tree rebase (the old stale-code vectors).
    assert.match(
      text,
      /ops\/state-push\.sh/,
      `${file}: state pushes must go through ops/state-push.sh`,
    );
    assert.doesNotMatch(
      text,
      /git rebase/,
      `${file}: no working-tree rebase onto the data branch (stale-code vector)`,
    );
    assert.doesNotMatch(
      text,
      /HEAD:refs\/heads\/data/,
      `${file}: no whole-checkout pushes to the data branch (issue #20)`,
    );
  }
  console.log(
    "  ✓ workflows (govwatch, electionday, social): code from main, state-only pushes",
  );
}

// ---------------------------------------------------------------------------
// ops/state-push.sh: temp-index + commit-tree plumbing, never touches HEAD
// ---------------------------------------------------------------------------
{
  const text = read("ops/state-push.sh");
  assert.match(text, /git read-tree/, "builds the tree from the data tip");
  assert.match(
    text,
    /GIT_INDEX_FILE/,
    "uses a temp index (no HEAD/index churn)",
  );
  assert.match(
    text,
    /git commit-tree/,
    "commits via plumbing (no working-tree commit)",
  );
  assert.match(text, /refs\/heads\/data/, "targets the data branch");
  assert.match(text, /for attempt in/, "retries concurrent-writer races");
  // Operative (non-comment) lines must be plumbing-only: no checkout, no
  // rebase, no branch switch — the helper can never execute or carry code.
  const code = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(
    code,
    /git (checkout|rebase|switch|restore)\b/,
    "state-push must be plumbing-only",
  );
  assert.doesNotMatch(
    code,
    /git add\b(?!.*-f)/,
    "state files are gitignored — every add must be forced",
  );
  console.log(
    "  ✓ state-push.sh: temp-index + commit-tree plumbing, race-retried",
  );
}

// ---------------------------------------------------------------------------
// scripts/reconcile-data-branch.sh: force-with-lease rebuild onto main
// ---------------------------------------------------------------------------
{
  const text = read("scripts/reconcile-data-branch.sh");
  assert.match(
    text,
    /--force-with-lease/,
    "reconcile must push with --force-with-lease (no clobbering a concurrent push)",
  );
  assert.match(
    text,
    /git commit-tree/,
    "plumbing commit, no working-tree churn",
  );
  assert.match(text, /refs\/heads\/data/, "targets the data branch");
  assert.match(
    text,
    /origin\/main/,
    "reconciles onto current main (merge-base(data, main) = main after run)",
  );
  for (const f of ["data/govt-readings.json", "data/observations.jsonl"]) {
    assert.ok(
      text.includes(f),
      `reconcile must carry state file ${f} from the old data tip`,
    );
  }
  const code = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(
    code,
    /git (checkout|rebase|switch)\b/,
    "reconcile must be plumbing-only (never touches the working tree)",
  );
  console.log(
    "  ✓ reconcile script: force-with-lease rebuild of data onto main",
  );
}

// ---------------------------------------------------------------------------
// Systemd units ExecStart the TRACKED runner (issue #24)
// ---------------------------------------------------------------------------
// Incident: 2026-10-28 — every deployed feedflag-*.service ExecStarted an
// UNTRACKED copy of the runner at the repo root on the box, which `git pull`
// can never update. The stale v5 copy kept committing state onto local main
// and re-wedged the box within 4 ticks of the manual unstick. The unit
// templates in ops/bastion/ are the source of truth and must ExecStart the
// tracked script so the self-healing pull (issue #22) actually deploys it.
{
  const bastionDir = join(ROOT, "ops", "bastion");
  const entries = readdirSync(bastionDir).sort();
  const serviceFiles = entries.filter((e) => e.endsWith(".service"));
  const timerFiles = entries.filter((e) => e.endsWith(".timer"));
  const MODES = ["heartbeat", "govwatch", "peak", "social", "hot"];

  assert.ok(
    serviceFiles.length >= 5,
    `expected the 5 timer service templates in ops/bastion/, found ${serviceFiles.length}: ${serviceFiles.join(", ")}`,
  );

  for (const file of serviceFiles) {
    const text = readFileSync(join(bastionDir, file), "utf8");
    const match = text.match(/ExecStart=(\S+)\s+(\w+)\s*$/m);
    assert.ok(
      match,
      `${file}: must have an ExecStart line ending in a runner mode`,
    );
    assert.equal(
      match[1],
      "/opt/feedflag/ops/bastion/run-timer.sh",
      `${file}: ExecStart must be the TRACKED runner /opt/feedflag/ops/bastion/run-timer.sh (an untracked root copy is the silent-stale-code vector from issue #24)`,
    );
    assert.ok(
      MODES.includes(match[2]),
      `${file}: ExecStart mode "${match[2]}" must be one the runner implements (${MODES.join("|")})`,
    );
    // Every service has a matching timer template — the repo stays the
    // complete source of truth for /etc/systemd/system/.
    const timer = file.replace(/\.service$/, ".timer");
    assert.ok(
      timerFiles.includes(timer),
      `${file}: matching ${timer} template must exist in ops/bastion/`,
    );
    const timerText = readFileSync(join(bastionDir, timer), "utf8");
    assert.match(
      timerText,
      /OnCalendar=\*:0\/(15|30)/,
      `${timer}: must carry the expected OnCalendar cadence`,
    );
    assert.match(
      timerText,
      /Persistent=true/,
      `${timer}: must be Persistent=true`,
    );
  }

  console.log(
    `  ✓ all ${serviceFiles.length} service templates ExecStart the tracked runner (issue #24)`,
  );
}

// ---------------------------------------------------------------------------
// No tracked file references the UNTRACKED root-runner path (issue #24)
// ---------------------------------------------------------------------------
// The bad literal is the deployed ExecStart path of the stale root copy. It
// must appear in NO tracked file: if a template, script, or doc ever carries
// it again, a deploy resurrects the vector. The README documents the vector
// without spelling the path so this sweep can be absolute — and this file
// builds the needle by concatenation so even this test's own source stays
// clean (the sweep reads every file in the repo, including itself).
{
  const BAD = ["/opt/feedflag", "run-timer.sh"].join("/");
  const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-inputs"]);
  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* walk(p);
      else yield p;
    }
  }
  for (const path of walk(ROOT)) {
    const text = readFileSync(path, "utf8");
    assert.ok(
      !text.includes(BAD),
      `${path}: must not reference the untracked root runner path ${BAD} (issue #24)`,
    );
  }
  console.log("  ✓ no tracked file references the untracked root runner path");
}

// ---------------------------------------------------------------------------
// Runner self-integrity: every function the dispatch + pipeline calls is
// defined in run-timer.sh (PR #29 regression)
// ---------------------------------------------------------------------------
// PR #29 used the `IN_WINDOW() { … }` definition as an edit anchor and its
// replacement DELETED the definition — bash -n passes a missing function
// (it is not a syntax error) and the legs silently take their else-branches:
// the pipeline ran dark 23:30–23:59 UTC on 2026-10-28 with "outside voting
// hours" at 23 UTC (an in-window hour). bash -n cannot catch this; this can.
// Keep REQUIRED_FNS current with the runner's function vocabulary.
{
  const runner = readFileSync(
    join(ROOT, "ops", "bastion", "run-timer.sh"),
    "utf8",
  );
  const defined = new Set(
    [...runner.matchAll(/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/gm)].map((m) =>
      m[0].replace(/\(\)\s*\{$/, ""),
    ),
  );
  const REQUIRED_FNS = [
    "maybe_alert",
    "heal_deploy",
    "heartbeat",
    "IN_WINDOW",
    "restore_state",
    "push_state",
  ];
  for (const fn of REQUIRED_FNS) {
    assert.ok(
      defined.has(fn),
      `run-timer.sh must define ${fn}() — bash -n cannot catch a deleted function (PR #29 deleted IN_WINDOW and the legs ran dark)`,
    );
  }
  // The dispatch case must still call every gated leg's helpers: the case
  // block is where a bad edit silently rewires the whole pipeline.
  const caseStart = runner.indexOf("case $MODE in");
  const caseEnd = runner.indexOf("esac", caseStart);
  assert.ok(
    caseStart > -1 && caseEnd > caseStart,
    "run-timer.sh: no dispatch case block found",
  );
  const dispatch = runner.slice(caseStart, caseEnd);
  for (const fn of ["restore_state", "IN_WINDOW"]) {
    assert.ok(
      dispatch.includes(fn),
      `run-timer.sh dispatch must invoke ${fn} (it is load-bearing for the legs)`,
    );
  }
  console.log(
    "  ✓ run-timer.sh defines + dispatches every load-bearing function (IN_WINDOW regression)",
  );
}

console.log("\nAll data-branch regression tests passed.");
