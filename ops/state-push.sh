#!/usr/bin/env bash
# state-push.sh — push a STATE-ONLY commit to refs/heads/data (issue #20, fix 1).
#
#   bash ops/state-push.sh -m "chore(data): message [skip ci]" FILE [FILE...]
#
# The `data` branch is a state store, NOT a deploy channel. The 2026-10-28
# incident: the govwatch backup executed code checked out from `data`, whose
# code tree had lagged main since 2026-10-24 (pre-gate), and re-posted frozen
# Clark NV waits at 95% confidence. After that fix nothing executes from
# `data`, and this helper guarantees no code can ride onto it again:
#
#   - the commit is built with git plumbing on a TEMP INDEX
#     (read-tree of the data-branch tip + exactly the named files from the
#     working tree, then write-tree + commit-tree) — the current checkout's
#     code tree is never part of the pushed commit;
#   - no working-tree rebase, no branch switching, nothing touches HEAD;
#   - a no-change run exits 0 without creating an empty commit;
#   - concurrent-writer races (bastion timer vs GH Actions workflows share
#     the branch) are retried: each attempt re-fetches the tip and rebuilds.
#
# Auth: inherits whatever credentials the calling git has (Actions GITHUB_TOKEN,
# or the bastion's http.extraheader via GIT_CONFIG_* env — see run-timer.sh).
#
# Plumbing errors fail loudly (exit 1 → the caller's alert path). An
# unresolvable push race is non-fatal (exit 0, logged) — the next run
# re-pushes the state; the local audit copy is never lost.
set -uo pipefail

MSG=""
FILES=()
while [ $# -gt 0 ]; do
  case $1 in
    -m)
      MSG="${2:-}"
      shift 2
      ;;
    *)
      FILES+=("$1")
      shift
      ;;
  esac
done

if [ -z "$MSG" ]; then
  echo "state-push: usage: ops/state-push.sh -m <message> FILE [FILE...]" >&2
  exit 2
fi
if [ ${#FILES[@]} -eq 0 ]; then
  echo "state-push: no state files given — nothing to do" >&2
  exit 2
fi
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "state-push: state file '$f' not in the working tree — refusing (caller must pass existing files)" >&2
    exit 2
  fi
done

git config user.name "feedflag-bot" || true
git config user.email "feedflag-bot@users.noreply.github.com" || true

TMPIDX=""
trap 'rm -f "$TMPIDX"' EXIT

for attempt in 1 2 3; do
  if ! git fetch -q origin refs/heads/data; then
    echo "state-push: no refs/heads/data yet — skipping (nothing to update)" >&2
    exit 0
  fi
  BASE=$(git rev-parse -q --verify FETCH_HEAD) || {
    echo "state-push: cannot resolve data-branch tip — skipping" >&2
    exit 0
  }

  # Build the state-only tree on a temp index: data-branch tip's full tree,
  # then overlay exactly the named state files from THIS working tree. The
  # rest of the tree (and only the rest) comes from the data tip itself —
  # no code from the current checkout is ever involved.
  TMPIDX="$(mktemp)" || exit 1
  GIT_INDEX_FILE="$TMPIDX" git read-tree "$BASE" || exit 1
  GIT_INDEX_FILE="$TMPIDX" git add -f -- "${FILES[@]}" || exit 1
  TREE=$(GIT_INDEX_FILE="$TMPIDX" git write-tree) || exit 1
  rm -f "$TMPIDX"

  if [ "$TREE" = "$(git rev-parse "$BASE^{tree}")" ]; then
    echo "state-push: state unchanged vs data-branch tip — nothing to commit"
    exit 0
  fi

  COMMIT=$(git commit-tree "$TREE" -p "$BASE" -m "$MSG") || exit 1
  if git push -q origin "$COMMIT:refs/heads/data"; then
    echo "state-push: pushed state-only commit ${COMMIT:0:12} (base ${BASE:0:12})"
    exit 0
  fi
  echo "state-push: data branch moved since fetch (concurrent writer) — retrying (attempt $attempt)" >&2
  sleep 5
done

echo "state-push: data branch kept moving — giving up this run (non-fatal; next run re-pushes)" >&2
exit 0
