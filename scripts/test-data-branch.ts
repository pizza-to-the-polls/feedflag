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
  // Issue #31 adds the two feedflag.yml steps that had no bastion
  // equivalent: digest (daily 02:00 UTC findings digest + Slack mirror —
  // the only writer of findings issue #5) and reactions (Slack 👍/👎 →
  // data/labels.jsonl). Both go dark when the Actions schedule is off.
  const MODES = [
    "heartbeat",
    "govwatch",
    "peak",
    "social",
    "hot",
    "digest",
    "reactions",
  ];

  assert.ok(
    serviceFiles.length >= MODES.length,
    `expected ${MODES.length} timer service templates in ops/bastion/, found ${serviceFiles.length}: ${serviceFiles.join(", ")}`,
  );
  for (const mode of MODES) {
    assert.ok(
      serviceFiles.includes(`feedflag-${mode}.service`),
      `ops/bastion/feedflag-${mode}.service must exist (mode ${mode} is implemented by run-timer.sh)`,
    );
  }

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
    // Cadence per mode (issue #31): digest is once daily at 02:00 UTC
    // (same one-per-day gate as the workflow step), reactions is hourly at
    // :20 (offset off the busy :0/:15/:30 marks), everything else rides the
    // 15/30-min slice boundaries.
    const mode = match[2]!;
    if (mode === "digest") {
      assert.match(
        timerText,
        /OnCalendar=\*-\*-\* 02:00:00/,
        `${timer}: digest must fire daily at 02:00 UTC (parity with the feedflag.yml 02:00 UTC gate)`,
      );
    } else if (mode === "reactions") {
      assert.match(
        timerText,
        /OnCalendar=\*:20/,
        `${timer}: reactions must fire hourly at :20 (offset from the :0/:15/:30 marks)`,
      );
    } else {
      assert.match(
        timerText,
        /OnCalendar=\*:0\/(15|30)/,
        `${timer}: must carry the expected OnCalendar cadence`,
      );
    }
    assert.match(
      timerText,
      /Persistent=true/,
      `${timer}: must be Persistent=true`,
    );
  }

  // The runner must implement every mode a unit ExecStarts — a unit fired
  // against an unimplemented mode exits 1 on the `unknown mode` branch, a
  // silent dark leg (issue #31: digest + reactions were exactly the two
  // feedflag.yml steps with no bastion case). HEARTBEAT IS THE EXCEPTION:
  // a lock-free early exit, not a case label — pinned below.
  // feedflag.yml steps with no bastion case).
  const runnerText = readFileSync(join(bastionDir, "run-timer.sh"), "utf8");
  for (const mode of MODES.filter((m) => m !== "heartbeat")) {
    assert.match(
      runnerText,
      new RegExp(`^\\s{2}${mode}\\)`, "m"),
      `run-timer.sh must implement the "${mode}" mode (case label)`,
    );
  }

  // Heartbeat is the exception: a LOCK-FREE early exit, not a case label.
  // The 2026-10-31 interaction: the unit is capped at TimeoutStartSec=2min
  // (anti-wedge: a wedged heartbeat must die fast) while the lock wait is
  // 600s (#64: working-Apify peak legs run 6+ min), so a heartbeat queued
  // behind long govt/peak legs was hard-killed at 120s 2-4x/hour — and
  // since the metric post also sat behind the lock, those ticks posted
  // nothing: the dead-man went dark while legs were merely busy. Pin the
  // shape AND the ordering so no future edit moves it back behind the lock.
  const heartbeatExit = runnerText.match(
    /^if \[ "\$MODE" = "heartbeat" \]; then\n  heartbeat\n  echo "\[timer\] heartbeat only[^"\n]*"\n  exit 0\nfi$/m,
  );
  assert.ok(
    heartbeatExit,
    "run-timer.sh: heartbeat must be a lock-free early exit that posts the CW metric and exits 0",
  );
  const lockIdx = runnerText.indexOf("exec 9>/opt/feedflag/.run-lock");
  assert.ok(
    lockIdx !== -1 &&
      heartbeatExit !== null &&
      runnerText.indexOf(heartbeatExit[0]) < lockIdx,
    "run-timer.sh: the heartbeat early exit must run BEFORE the run-lock acquisition",
  );
  // Digest mode content parity with the feedflag.yml "Post findings digest"
  // step: 26h digest + --report-only addendum + issue #5 comment + Slack
  // mirror; and it needs its own credential (issues:write PAT) in the boot
  // gate so a missing token fails LOUDLY instead of going dark.
  const digestCase = runnerText.match(/^  digest\)[\s\S]*?^    ;;/m);
  assert.ok(digestCase, "run-timer.sh: digest case block must exist");
  for (const [needle, what] of [
    ["scripts/digest.ts --hours 26", "26h digest build"],
    ["extract-wait-times.ts --report-only", "govwait board addendum"],
    [
      "api.github.com/repos/",
      "issue #5 comment post (curl — this box has no gh)",
    ],
    ["--purpose feedflag-digest", "purpose-scoped token mint"],
    ["SLACK_WEBHOOK_URL", "Slack mirror"],
  ] as const) {
    assert.ok(
      digestCase[0].includes(needle),
      `run-timer.sh digest case must include ${what} (${needle})`,
    );
  }
  assert.match(
    digestCase[0],
    /exit 0/,
    "run-timer.sh digest case must exit before the shared post-run block (read-only: no emit/push)",
  );
  // The boot env gate runs BEFORE the mode dispatch and exits 1, so it must
  // never list a credential only one mode needs. FEEDFLAG_DIGEST_TOKEN in
  // REQUIRED would fail EVERY leg (heartbeat, social, peak, hot, govwatch) at
  // the first tick after deploy — the deploy pull above resets to origin/main,
  // so the gate change goes live on its own, ≤15 min after merge, with no unit
  // install required. The digest mints a 1h repo-scoped issues:write token at
  // run time instead (pizza-eagle#44/#45), so no durable PAT exists to require.
  assert.ok(
    !/REQUIRED="[^"\n]*FEEDFLAG_DIGEST_TOKEN/.test(runnerText),
    "run-timer.sh boot env gate must NOT require a digest-only credential — it exits 1 for every mode, so merging one darkens all the legs",
  );
  assert.ok(
    !digestCase[0].includes("FEEDFLAG_DIGEST_TOKEN"),
    "the digest must not read a long-lived PAT anywhere, including as a fallback",
  );
  assert.match(
    digestCase[0],
    /gh-token\.mjs[\s\S]*--purpose feedflag-digest/,
    "run-timer.sh digest case must mint a purpose-scoped token via the pizza-eagle broker",
  );
  assert.match(
    digestCase[0],
    /2>>\/tmp\/digest-mint\.log/,
    "the mint's stderr (metadata, never the token) must go to a log while stdout is captured",
  );
  assert.match(
    digestCase[0],
    /MINT FAILED/,
    "a failed mint must alert loudly and exit 1 — never post without a token, never skip silently",
  );
  assert.ok(
    !digestCase[0].includes("command -v gh"),
    "the gh branch is gone: gh is not installed on this box (verified 2026-10-30), so it was unreachable dead code",
  );
  // Reactions mode: runs collect-reactions.ts UNCHANGED, gated by IN_WINDOW
  // like the other voting-hours legs, and flows through restore/push (it
  // appends to data/labels.jsonl — state).
  const reactionsCase = runnerText.match(/^  reactions\)[\s\S]*?^    ;;/m);
  assert.ok(reactionsCase, "run-timer.sh: reactions case block must exist");
  assert.ok(
    reactionsCase[0].includes("scripts/collect-reactions.ts"),
    "run-timer.sh reactions case must run scripts/collect-reactions.ts unchanged",
  );
  assert.match(
    reactionsCase[0],
    /IN_WINDOW/,
    "run-timer.sh reactions case must gate on voting hours (IN_WINDOW, like peak/social)",
  );
  assert.match(
    reactionsCase[0],
    /restore_state/,
    "run-timer.sh reactions case must restore shared state (it reads data/labels.jsonl to dedupe)",
  );

  console.log(
    `  ✓ all ${serviceFiles.length} service templates ExecStart the tracked runner (issue #24)`,
  );
  console.log(
    "  ✓ runner implements digest (issue #5 + Slack, read-only) and reactions (labels.jsonl, gated) modes (issue #31)",
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
    "rotate_observations",
    "sync_env",
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

  // Single-flight lock (2026-10-30 state-clobber incident): all legs share
  // one working tree while the extractor persists govt-readings.json
  // mid-run per source — without flock, a sibling leg's state-push snapshots
  // the half-built file onto refs/heads/data (observed {} / 4-key / 34-key
  // partial states alternating with healthy peak pushes).
  assert.match(
    runner,
    /flock -w \d+ 9/,
    "run-timer.sh must serialize legs with flock (partial-state clobber regression)",
  );
  // The env auto-sync is the boot path that makes "save the token in Secrets
  // Manager" sufficient (2026-10-30: saves never reached the box — the .env
  // copy was manual and the instance role couldn't read the secret). It must
  // run BEFORE `source .env` and keep the current file on any failure.
  const envSync = runner.slice(0, runner.indexOf("set -a; source .env"));
  assert.ok(
    envSync.includes("sync_env") &&
      envSync.includes("secretsmanager get-secret-value"),
    "run-timer.sh must sync .env from Secrets Manager before sourcing it (save-never-sticks regression)",
  );
  assert.match(
    runner,
    /secretsmanager get-secret-value[\s\S]*?--secret-id ptp\/prod\/feedflag\/env/,
    "the sync must read the secret the operator actually saves into",
  );
  // Rotation is load-bearing post-run plumbing: invoked only after a
  // successful emit, so un-POSTed rows are never rotated away.
  const postRun = runner.slice(runner.indexOf("esac"));
  assert.ok(
    postRun.includes("rotate_observations"),
    "run-timer.sh must rotate observations.jsonl after a successful emit (62MB+ growth regression)",
  );

  // emit-to-db TOTAL FAILURE must not fire on the normal all-duplicates
  // re-run (every 15-min leg re-POSTs the same 4h window; the server
  // dedupes) — observed false alert 2026-10-30 03:15 social leg.
  const emit = readFileSync(join(ROOT, "scripts", "emit-to-db.ts"), "utf8");
  assert.match(
    emit,
    /sent > 0 && inserted === 0 && skipped === 0/,
    "emit-to-db TOTAL FAILURE must exclude the all-duplicates re-run case",
  );
  console.log(
    "  ✓ run-timer.sh defines + dispatches every load-bearing function (IN_WINDOW regression)",
  );
}

console.log("\nAll data-branch regression tests passed.");
