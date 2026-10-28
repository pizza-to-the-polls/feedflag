#!/bin/bash
# feedflag timer runner v5 — observability hardening (2026-10-27 postmortems)
#   * boot env validation — LOUD failure, never silent-skip (emit-dead-4-days)
#   * CloudWatch heartbeat metric every fire (box/timer-alive; CW alarm watches)
#   * emit-to-DB after every run — box runs now reach feed_observations (they
#     never did before; DB freshness = whole-chain health signal)
#   * throttled Slack alerts on leg failures (1h marker, not per-run spam)
#   * best-effort state push to refs/heads/data via state-only plumbing —
#     authed by FEEDFLAG_STATE_PUSH_TOKEN (scoped PAT, Secrets Manager;
#     issue #22) with gh-token.mjs as fallback; LOUD (maybe_alert) when it
#     can't fire
#   * restore shared state from refs/heads/data before every pipeline leg —
#     convergence with the GH Actions backup (one seen-store, no duplicate
#     flags in #feed-lines)
set -uo pipefail
MODE=$1
cd /opt/feedflag

ALERT_MARKER=/opt/feedflag/data/.alert-throttle
maybe_alert() {
  echo "[timer] ALERT: $1" >&2
  local now last=0
  now=$(date +%s)
  [ -f "$ALERT_MARKER" ] && last=$(stat -c %Y "$ALERT_MARKER" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt 3600 ]; then
    curl -s -m 10 -X POST -H 'content-type: application/json' \
      -d "{\"text\":\":rotating_light: $1\"}" \
      "${SLACK_WEBHOOK_URL:-}" >/dev/null 2>&1 || true
    touch "$ALERT_MARKER"
  fi
}

# ── deploy pull: self-healing (issue #22) ────────────────────────────────
# The old `git pull --ff-only` silently wedged when the local `main` branch
# had a commit that origin/main lacked (pre-#21 state commits): every ff
# pull failed non-fast-forward and the `|| echo` swallowed it, leaving the
# box running stale code forever. Now we fetch, check ancestry, and if the
# local branch diverged or the ff-merge fails we run the SAFE self-heal:
#   git reset --hard origin/main — wrapped in a state BACKUP by heal_deploy.
# Why the backup is load-bearing (2026-10-28 finding, issue #22 comment):
# main still TRACKED the six data/* state files (force-added before the
# data branch existed) — a bare `reset --hard` would have reverted the
# box's live state to main's stale blobs. This PR untracks them on main
# (git rm --cached — state lives ONLY on refs/heads/data), but the
# transition tick (this checkout still has them tracked) needs the
# backup/restore wrap, which also protects against any future regression.
# .env is gitignored and never touched by reset. See ops/bastion/README.md
# §deploy-model.
heal_deploy() {  # SAFE reset --hard origin/main: back up data/, reset, restore
  local bk
  bk=$(mktemp -d)
  [ -d data ] && cp -a data/. "$bk"/
  git reset --hard origin/main
  mkdir -p data && cp -a "$bk"/. data/ 2>/dev/null || true
  rm -rf "$bk"
}
# Concurrent-tick tolerance: all four feedflag-* units fire at the same
# second and race on the shared .git — a fetch that loses the lock fails
# with a lock error even though the remote is fine (observed 2026-10-28
# 21:30: two units alerted CANNOT FETCH while a sibling's fetch updated the
# ref and both runs still ended at the fresh SHA). Retry with backoff
# before believing the network is down.
fetch_ok=0
for i in 1 2 3; do
  if git fetch -q origin main 2>/dev/null; then fetch_ok=1; break; fi
  sleep $((i * 3))
done
[ "$fetch_ok" = 1 ] || maybe_alert "feedflag $(hostname): CANNOT FETCH origin/main after 3 tries ($MODE) — git remote or network down. Remediation on bastion: git fetch origin main && git reset --hard origin/main"
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "[timer] WARN: local main diverged from origin/main — safe-resetting to origin/main (data/ backed up + restored)"
  maybe_alert "feedflag $(hostname): local main diverged from origin/main ($MODE) — SAFE HEAL applied (reset --hard origin/main, state backed up + restored). If this repeats, run: git fetch origin main && git reset --hard origin/main on the bastion."
  heal_deploy
elif ! git merge --ff-only -q origin/main 2>/dev/null; then
  echo "[timer] WARN: ff-merge failed — safe-resetting to origin/main (data/ backed up + restored)"
  maybe_alert "feedflag $(hostname): git merge --ff-only failed ($MODE) — SAFE HEAL applied (reset --hard origin/main, state backed up + restored). Manual if repeats: git fetch origin main && git reset --hard origin/main on the bastion."
  heal_deploy
fi
# GUARD RAIL: nothing in this script ever commits to the local main branch.
# State (data/) goes out via ops/state-push.sh which builds plumbing commits
# directly on the remote data-branch tip — no local branch is involved. If
# you see `git commit` or `git add -f data` anywhere in this file, that's
# the pre-#21 wedge — remove it.

DEPLOY_SHA=$(git rev-parse --short HEAD)
ORIGIN_SHA=$(git rev-parse --short origin/main)
if [ "$DEPLOY_SHA" != "$ORIGIN_SHA" ]; then
  maybe_alert "feedflag $(hostname): HEAD ($DEPLOY_SHA) != origin/main ($ORIGIN_SHA) after deploy ($MODE) — may be running stale code. Remediation: git fetch origin main && git reset --hard origin/main on the bastion."
fi

set -a; source .env; set +a

heartbeat() {
  aws cloudwatch put-metric-data --namespace Feedflag --metric-name Heartbeat \
    --value 1 --unit Count --region us-west-2 >/dev/null 2>&1 || true
}

restore_state() {
  # Shared-state convergence — the duplicate-flag fix. The GH Actions backup
  # runs the SAME social pipeline every 30 min and restores state from the
  # data branch at ITS start (feedflag.yml, issue #20). The bastion never
  # did the mirror-image step: its local state diverged from the data branch
  # after every GH Actions state push, and (until the push itself was fixed,
  # PRs #26–#28) the bastion's seen-ids never reached the data branch at all
  # → the backup re-flagged posts the bastion had already flagged
  # (2026-10-28 22:51: @GretchenInOK flagged 21:30 by the bastion, re-flagged
  # 22:51 by GH Actions — duplicate post in #feed-lines). Restore the shared
  # state files before the run so both schedulers start from one seen-store.
  # Same per-file checkout + unstage as the GH Actions restore step (code
  # parity). Retry: concurrent feedflag-* units race on the index lock.
  # Non-fatal on total failure (warn): a stale shared state still beats a
  # divergent one — the run proceeds with local state.
  for i in 1 2 3; do
    if git fetch -q origin refs/heads/data 2>/dev/null; then
      local f
      for f in data/seen.json data/flagged.jsonl data/observations.jsonl data/reports-sync.json data/labels.jsonl data/govt-readings.json; do
        git checkout -q FETCH_HEAD -- "$f" 2>/dev/null || true
      done
      git reset -q -- data 2>/dev/null || true
      echo "[timer] shared state restored from refs/heads/data"
      return 0
    fi
    sleep $((i * 2))
  done
  echo "[timer] WARN: state restore from refs/heads/data failed — running with local state (possible duplicates vs the GH Actions backup)" >&2
}

push_state() {
  # Issue #20: STATE-ONLY push. The data branch is a state store, not a deploy
  # channel — the old `git push origin HEAD:refs/heads/data` sent this
  # checkout's whole code tree to the branch, and the branch's code (Oct 24,
  # pre-gate) is exactly what the 2026-10-28 backup executed to re-post frozen
  # Clark NV waits at 95%. ops/state-push.sh builds a plumbing commit (temp
  # index + commit-tree) on top of the data-branch tip with only the named
  # state files — no code rides along. The token rides via GIT_CONFIG_* env so
  # every git call inside the helper is authed.
  local files="" tok=""
  for f in data/govt-readings.json data/observations.jsonl data/seen.json data/flagged.jsonl data/labels.jsonl data/reports-sync.json; do
    [ -f "$f" ] && files="$files $f"
  done
  [ -z "$files" ] && return 0
  # Credential (issue #22): FEEDFLAG_STATE_PUSH_TOKEN — scoped fine-grained
  # PAT (contents:write, pizza-to-the-polls/feedflag ONLY) from Secrets
  # Manager ptp/prod/feedflag/env, landed in /opt/feedflag/.env. gh-token.mjs
  # stays as a fallback for contexts that CAN mint (a pizza-eagle listener
  # case) — it never could from this timer context (listener write-gate).
  tok="${FEEDFLAG_STATE_PUSH_TOKEN:-}"
  if [ -z "$tok" ]; then
    tok=$(node /opt/pizza-eagle/scripts/gh-token.mjs --repo pizza-to-the-polls/feedflag 2>/dev/null || true)
  fi
  if [ -n "$tok" ]; then
    # NOTE: `base64 | tr -d '\n'` — GNU coreutils base64 wraps at 76 cols
    # (AL2023), which puts a newline INSIDE the http.extraheader value and
    # libcurl rejects the whole request ("A libcurl function was given a bad
    # argument") — observed 2026-10-28 22:30: every state push silently
    # took the fetch-skip path. tr -d is a no-op on BSD/macOS base64.
    hdr=$(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $hdr" \
      bash ops/state-push.sh -m "chore(data): timer state ($MODE) head=$DEPLOY_SHA [skip ci]" $files \
      || maybe_alert "feedflag $(hostname): timer state push to refs/heads/data FAILED ($MODE) — box state is NOT backed up to git. Check ops/state-push.sh + the token on the bastion."
  else
    # Loud until the scoped credential is in place: without it the box state
    # push silently never fired its whole life (2026-10-28 finding). The
    # remediation is the FEEDFLAG_STATE_PUSH_TOKEN key in Secrets Manager
    # ptp/prod/feedflag/env + a .env re-sync on the bastion.
    maybe_alert "feedflag $(hostname): timer state push SKIPPED — no FEEDFLAG_STATE_PUSH_TOKEN ($MODE). Add the scoped state-push PAT to Secrets Manager ptp/prod/feedflag/env and re-sync /opt/feedflag/.env on the bastion — box state is NOT backed up to git. (gh-token.mjs cannot mint from the timer context — listener write-gate.)"
  fi
}

# ---- boot: heartbeat + LOUD env validation -------------------------------
heartbeat
REQUIRED="OPENROUTER_API_KEY APIFY_API_TOKEN PIZZABASE_API_URL PIZZABASE_API_KEY SLACK_WEBHOOK_URL SLACK_BOT_TOKEN SLACK_FLAG_CHANNELS"
MISSING=""
for v in $REQUIRED; do
  [ -z "${!v:-}" ] && MISSING="$MISSING $v"
done
if [ -n "$MISSING" ]; then
  maybe_alert "feedflag BOOT FAILURE on $(hostname) ($MODE) — missing env:$MISSING — leg would run DEAF. Fix ptp/prod/feedflag/env (Secrets Manager); next tick retries."
  exit 1
fi

# ---- the work --------------------------------------------------------------
case $MODE in
  heartbeat) echo "[timer] heartbeat only"; exit 0 ;;
  govwatch) restore_state; node --import tsx scripts/extract-wait-times.ts ;;
  peak)     if IN_WINDOW; then restore_state; node --import tsx scripts/extract-wait-times.ts; else echo "peak: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  social)   if IN_WINDOW; then restore_state; node --import tsx src/index.ts; else echo "social: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  hot)      if date -u +%Y-%m-%d | grep -qE '2026-11-0[234]'; then restore_state; node --import tsx scripts/extract-wait-times.ts; else echo "hot: not in election window"; exit 0; fi ;;
  *) echo "unknown mode: $MODE" >&2; exit 1 ;;
esac
RUN_RC=$?

# ---- post: emit to DB (box runs reach feed_observations), then state ------
if [ $RUN_RC -ne 0 ]; then
  maybe_alert "feedflag $(hostname): $MODE run FAILED (rc=$RUN_RC) — pipeline leg down. journalctl -u feedflag-$MODE.service on the bastion."
else
  node --import tsx scripts/emit-to-db.ts --hours 4 \
    || maybe_alert "feedflag $(hostname): emit-to-DB TOTAL FAILURE ($MODE) — observations NOT reaching feed_observations. Check PIZZABASE_API_* + API health."
fi
push_state
heartbeat
echo "[timer] $MODE done rc=$RUN_RC head=$DEPLOY_SHA"
exit $RUN_RC