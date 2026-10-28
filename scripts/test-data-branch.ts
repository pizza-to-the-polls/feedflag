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
import { readFileSync } from "node:fs";
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
    // 1. Code NEVER comes from the data branch.
    assert.doesNotMatch(
      text,
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

console.log("\nAll data-branch regression tests passed.");
