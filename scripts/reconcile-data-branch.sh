#!/usr/bin/env bash
# reconcile-data-branch.sh — one-time rebuild of the `data` branch onto
# current main (issue #20, fix 2).
#
# Why: the `data` branch carried pipeline state AND executable code, and its
# code tree had lagged main since 2026-10-24 (pre-gate: no src/govt/gates.ts,
# no nextFreshness) — so any workflow executing from it bypassed the
# issue-#12 freshness/hours gates. On 2026-10-28 the govwatch backup did
# exactly that and re-posted frozen Clark NV waits at 95% confidence. After
# the issue-#20 workflow fix nothing executes from `data`, but the branch is
# rebuilt onto current main anyway so the stale-code vector is gone for good
# and merge-base(data, main) is current main.
#
# What it does (pure git plumbing — never touches your working tree or HEAD):
#   1. fetch main + data
#   2. build a tree = current main's tree, with data/govt-readings.json and
#      data/observations.jsonl taken from the current data tip
#   3. commit it on top of the current data tip (history preserved)
#   4. force-with-lease push to refs/heads/data
#
# Safe to re-run: no-ops when the data tip already carries this exact tree.
# Run it from any checkout of this repo with push rights to refs/heads/data:
#
#   bash scripts/reconcile-data-branch.sh
#
# After this, the govt/social workflows check out main, overlay state from
# refs/heads/data at boot, and push state-only commits via ops/state-push.sh —
# they never see (or produce) executable code on the data branch again.
set -euo pipefail

MSG="chore(data): reconcile onto current main — state-only branch (issue #20) [skip ci]"
STATE_FILES=(data/govt-readings.json data/observations.jsonl)

git fetch -q origin main data
MAIN=$(git rev-parse origin/main)
DATA=$(git rev-parse origin/data)
echo "reconcile: main=${MAIN:0:12} data=${DATA:0:12}"

TMPIDX="$(mktemp)"
trap 'rm -f "$TMPIDX"' EXIT

# Tree = current main, then overlay the state files from the old data tip.
GIT_INDEX_FILE="$TMPIDX" git read-tree "$MAIN"
for f in "${STATE_FILES[@]}"; do
  if GIT_INDEX_FILE="$TMPIDX" git cat-file -e "$DATA:$f" 2>/dev/null; then
    GIT_INDEX_FILE="$TMPIDX" git restore --staged --source="$DATA" -- "$f"
  else
    echo "reconcile: note: $f not on old data tip — starting without it"
  fi
done
TREE=$(GIT_INDEX_FILE="$TMPIDX" git write-tree)

if [ "$TREE" = "$(git rev-parse "$DATA^{tree}")" ]; then
  echo "reconcile: data branch already carries this tree — nothing to do"
  exit 0
fi

COMMIT=$(git commit-tree "$TREE" -p "$DATA" -m "$MSG")
echo "reconcile: pushing ${COMMIT:0:12} (tree ${TREE:0:12}, parent ${DATA:0:12})"
git push --force-with-lease=refs/heads/data:"$DATA" origin "$COMMIT:refs/heads/data"
echo "reconcile: done — refs/heads/data now carries current main's tree + the state files."
echo "reconcile: backup runs check out main for code; the data branch is state-only from here."
