#!/bin/bash
# feedflag timer runner v5 — observability hardening (2026-10-27 postmortems)
#   * boot env validation — LOUD failure, never silent-skip (emit-dead-4-days)
#   * CloudWatch heartbeat metric every fire (box/timer-alive; CW alarm watches)
#   * emit-to-DB after every run — box runs now reach feed_observations (they
#     never did before; DB freshness = whole-chain health signal)
#   * throttled Slack alerts on leg failures (1h marker, not per-run spam)
#   * best-effort state push to refs/heads/data via pizza-eagle agent token
set -uo pipefail
MODE=$1
cd /opt/feedflag
git pull --ff-only -q origin main || echo "[timer] pull skipped — running current checkout"
set -a; source .env; set +a

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

heartbeat() {
  aws cloudwatch put-metric-data --namespace Feedflag --metric-name Heartbeat \
    --value 1 --unit Count --region us-west-2 >/dev/null 2>&1 || true
}

IN_WINDOW() { H=$(date -u +%H); [ "$H" -ge 12 ] || [ "$H" -lt 4 ]; }

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
  tok=$(node /opt/pizza-eagle/scripts/gh-token.mjs --repo pizza-to-the-polls/feedflag 2>/dev/null || true)
  if [ -n "$tok" ]; then
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$tok" | base64)" \
      bash ops/state-push.sh -m "chore(data): timer state ($MODE) [skip ci]" $files \
      || echo "[timer] data push failed (token read-only?) — CW + DB observability unaffected"
  else
    echo "[timer] data push skipped — no token"
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
  govwatch) node --import tsx scripts/extract-wait-times.ts ;;
  peak)     if IN_WINDOW; then node --import tsx scripts/extract-wait-times.ts; else echo "peak: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  social)   if IN_WINDOW; then node --import tsx src/index.ts; else echo "social: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  hot)      if date -u +%Y-%m-%d | grep -qE '2026-11-0[234]'; then node --import tsx scripts/extract-wait-times.ts; else echo "hot: not in election window"; exit 0; fi ;;
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
echo "[timer] $MODE done rc=$RUN_RC"
exit $RUN_RC