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

# ── single-flight lock (2026-10-30 state-clobber incident) ───────────────
# All feedflag-* units fire the same second and share this working tree, the
# .git, and every data/ state file. extract-wait-times persists
# data/govt-readings.json INCREMENTALLY (after each source), so a sibling
# leg finishing mid-extraction pushed half-built states to refs/heads/data
# (observed 2026-10-29/30: {}/4-key/34-key partials rode social pushes
# between healthy peak pushes, then rode restore_state back onto the box).
# Serialize the WHOLE leg — deploy pull included (a reset --hard racing a
# live extraction is the same bug). A leg that can't take the lock within
# 10 min skips its tick; the next 15-min fire retries. 2026-10-30: with a
# WORKING Apify token the web-tier vision fallbacks actually run and a peak
# extraction takes 6+ min (it was ~30s when Apify 401'd instantly) — 300s
# starved the social leg out of its tick. Heartbeat waits too —
# the CW dead-man alarms on long gaps, not one skipped tick.
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

# ── heartbeat: LOCK-FREE, by design ──────────────────────────────────────
# The heartbeat is the dead-man signal: ONE CloudWatch put, no state files,
# no tree access — nothing the single-flight lock exists to protect. It
# exits BEFORE the lock because waiting is fatal to it: the anti-wedge
# commit caps this unit at TimeoutStartSec=2min (a wedged heartbeat must
# die fast — election-night 2026-10-31), while the lock wait is 600s (#64:
# working-Apify peak legs run 6+ min). A heartbeat queued behind the
# govt/peak legs on every :00/:30 tick was hard-killed at 120s 2-4x/hour
# with "Failed with result 'timeout'" — and because the boot-time heartbeat
# call sat AFTER the lock, those killed ticks never posted the CW metric
# either: the dead-man went dark while legs were merely busy. Posting
# lock-free fixes both — the metric flows during long AND wedged legs, and
# the unit exits in ~2s. The deploy pull is redundant on heartbeat ticks:
# the other seven fires per hour own it.
if [ "$MODE" = "heartbeat" ]; then
  heartbeat
  echo "[timer] heartbeat only (metric posted, lock-free)"
  exit 0
fi

exec 9>/opt/feedflag/.run-lock
if ! flock -w 600 9; then
  echo "[timer] another feedflag leg holds the run lock >5min — skipping this tick ($MODE)"
  # 2026-10-31 election-night wedge: a peak leg spun a full core holding this
  # lock until a manual EC2 reboot — timers kept firing, heartbeats stayed
  # green, and these skip lines only reached journald. Make a held lock
  # observable: a LockWait datapoint (alarm feedflag-lock-wait → SNS
  # feedflag-alerts) + a throttled Slack page. Next tick retries either way.
  aws cloudwatch put-metric-data --namespace Feedflag --metric-name LockWait \
    --value 1 --unit Count --region us-west-2 >/dev/null 2>&1 || true
  maybe_alert "feedflag run-lock held >10min on $(hostname) — a leg (likely peak) is wedged or very long; ticks are being skipped. journalctl -t run-timer on the box."
  exit 0
fi

# Digest targets (issue #31) — overridable from .env; never REQUIRED.
FINDINGS_ISSUE="${FINDINGS_ISSUE:-5}"
FEEDFLAG_REPO_SLUG="${FEEDFLAG_REPO_SLUG:-pizza-to-the-polls/feedflag}"


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

# ---- boot: env auto-sync — "save the token in Secrets Manager" must be enough ----
# 2026-10-30: the APIFY_API_TOKEN had been saved to ptp/prod/feedflag/env many
# times while the box kept running the stale /opt/feedflag/.env — the sync was
# manual root work that silently never happened, the instance role couldn't
# read the secret to heal itself, and nothing ever told the operator their
# save didn't take. This timer runs as root and pulls the secret at boot:
# save → next tick (≤15 min) → live. On any failure the current .env is kept.
sync_env() {
  local tmp tmpjson tok
  tmp=$(mktemp) && tmpjson=$(mktemp) || return 0
  if ! aws secretsmanager get-secret-value --secret-id ptp/prod/feedflag/env \
      --query SecretString --output text --region us-west-2 > "$tmpjson" 2>/dev/null; then
    if [ ! -f /opt/feedflag/.env-sync-failed ]; then
      echo "[timer] WARN: cannot read ptp/prod/feedflag/env — .env NOT auto-synced (instance role missing secretsmanager:GetSecretValue on ptp/prod/feedflag/*?); using current file" >&2
      touch /opt/feedflag/.env-sync-failed
    fi
    rm -f "$tmp" "$tmpjson"; return 0
  fi
  rm -f /opt/feedflag/.env-sync-failed
  python3 - "$tmpjson" > "$tmp" <<'PY' || { rm -f "$tmp" "$tmpjson"; return 0; }
import json, sys
env = json.load(open(sys.argv[1]))
def q(v):
    return "'" + str(v).replace("'", "'\\''") + "'"
for k in sorted(env):
    print(f"{k}={q(env[k])}")
PY
  if ! cmp -s "$tmp" /opt/feedflag/.env 2>/dev/null; then
    cp -a /opt/feedflag/.env /opt/feedflag/.env.bak 2>/dev/null || true
    cat "$tmp" > /opt/feedflag/.env && chmod 600 /opt/feedflag/.env
    echo "[timer] .env re-synced from Secrets Manager (previous copy: .env.bak)"
    # A saved-but-BAD token must be VISIBLE — never let a save fail silently
    # again. Validity only; the token value is never echoed.
    tok=$(grep -m1 -oE '^APIFY_API_TOKEN=.+$' /opt/feedflag/.env | cut -d= -f2- | tr -d "'\"")
    if [ -n "$tok" ] && ! curl -s -m 10 -H "Authorization: Bearer $tok" \
        https://api.apify.com/v2/users/me 2>/dev/null | grep -q '"username"'; then
      maybe_alert "feedflag .env synced from Secrets Manager but the APIFY_API_TOKEN was REJECTED by Apify — the saved token is expired/invalid. Update it in Secrets Manager ptp/prod/feedflag/env; nothing else needed (next tick auto-syncs)."
    fi
  fi
  rm -f "$tmp" "$tmpjson"
}
sync_env

set -a; source .env; set +a

# Voting-hours gate for the peak/social legs (7am–11pm ET = 12:00–03:59 UTC,
# bumped 2026-11-01 post-DST). NOTE: PR #29 accidentally deleted this
# definition (used as an edit anchor) — bash -n can't catch a missing
# function, so both legs silently took the outside-hours branch and the
# pipeline went dark 23:30–23:59 UTC on election-eve eve. Restored + a
# test now asserts every function the case block calls is defined.
IN_WINDOW() { H=$(date -u +%H); [ "$H" -ge 12 ] || [ "$H" -lt 4 ]; }

# observations.jsonl is an append-only audit trail whose rows live in the DB
# once emit-to-db lands them. Unbounded it hit 62-70MB in a week — GitHub
# warns at 50MB and hard-blocks the push at 100MB, and every emit re-reads
# the whole file. After a SUCCESSFUL emit, rotate the live file out of the
# repo: gzip to /opt/feedflag-archive/ (stays on the box, never rides
# refs/heads/data). The DB is the system of record; the archive is the local
# belt-and-braces copy. Rotation on emit success means un-POSTed rows are
# never rotated away mid-flight (flock above guarantees no sibling writer).
ARCHIVE_DIR=/opt/feedflag-archive
# 2026-10-30: rotation must leave an EMPTY file in place (`: > "$f"` after the
# mv — mv alone deletes it): the data-branch tip's tree still carried the big
# blob, so the next leg's restore_state resurrected 70MB every tick and the
# loop re-archived + re-pushed a fresh ~70MB blob per run (GitHub hard-blocks
# blobs >100MB — this was hours from breaking state pushes).
rotate_observations() {
  local f=data/observations.jsonl size cap=20971520  # 20MB
  [ -f "$f" ] || return 0
  size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  [ "$size" -lt "$cap" ] && return 0
  mkdir -p "$ARCHIVE_DIR"
  local dest="$ARCHIVE_DIR/observations-$(date -u +%Y%m%d-%H%M%S).jsonl"
  if mv "$f" "$dest" && gzip -q "$dest" && : > "$f"; then
    echo "[timer] observations.jsonl rotated ($size bytes → $dest.gz)"
  else
    echo "[timer] WARN: observations rotation failed — file left as-is" >&2
  fi
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
    maybe_alert "feedflag $(hostname): timer state push SKIPPED — no FEEDFLAG_STATE_PUSH_TOKEN ($MODE). Add the scoped state-push PAT to Secrets Manager ptp/prod/feedflag/env and re-sync /opt/feedflag/.env on the bastion — box state is NOT backed up to git. (Since pizza-eagle#45 a timer CAN mint via gh-token.mjs --purpose, so this PAT could become a contents:write purpose mint — tracked as a follow-up, not done here.)"
  fi
}

# Voting-hours gate (2026-10-27 postmortem: overnight runs are dark — no
# polling when polls are closed). True when the current UTC hour is inside
# the 12:00–03:59 UTC window (7am–11pm ET). Used by the peak, social, and
# reactions legs (issue #31); an undefined gate here would throw "command
# not found" (exit 127 → falsy) and silently skip every gated leg.
IN_WINDOW() {
  local h
  h=$(date -u +%H)
  [ "$h" -ge 12 ] || [ "$h" -le 3 ]
}

# ---- boot: heartbeat + LOUD env validation -------------------------------
heartbeat
# The digest no longer needs a credential here: it mints a 1h repo-scoped
# token at run time via pizza-eagle's broker (see the digest) mode below).
# FEEDFLAG_DIGEST_TOKEN was removed from REQUIRED on purpose — this gate runs
# BEFORE the mode dispatch and exits 1, so a digest-only credential listed here
# would have failed EVERY leg (heartbeat, social, peak, hot, govwatch) at the
# first tick after deploy, since the deploy pull above resets to origin/main.
# Per-mode REQUIRED subsets are still a later refactor; until then nothing
# mode-specific belongs in this list.
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
  # heartbeat: handled lock-free above — see the heartbeat block comment.
  govwatch) restore_state; node --import tsx scripts/extract-wait-times.ts ;;
  peak)     if IN_WINDOW; then restore_state; node --import tsx scripts/extract-wait-times.ts; else echo "peak: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  social)   if IN_WINDOW; then restore_state; node --import tsx src/index.ts; else echo "social: outside voting hours ($(date -u +%H) UTC)"; exit 0; fi ;;
  hot)      if date -u +%Y-%m-%d | grep -qE '2026-11-0[234]'; then restore_state; node --import tsx scripts/extract-wait-times.ts; else echo "hot: not in election window"; exit 0; fi ;;
  digest)
    # Issue #31: daily at 02:00 UTC — bastion port of the feedflag.yml
    # "Post findings digest" step (the ONLY writer of findings issue #5).
    # Read-only leg: it consumes data/observations.jsonl + data/labels.jsonl
    # (kept current by the 15-min legs' restore/push cycle) and writes to
    # git issue #5 + Slack — never to state — so it skips restore_state /
    # push_state / emit-to-DB entirely and exits before the shared post-run
    # block. 26h window (02:00 fire covers the full US day + margin),
    # matching the workflow's --hours 26.
    echo "[timer] digest: building 26h findings digest"
    # Hard-fail on generation errors: a partial/empty /tmp/digest.md must
    # NEVER be posted as an issue #5 comment (that's worse than a stale
    # digest — the issue is the durable daily surface).
    if ! node --import tsx scripts/digest.ts --hours 26 --source db > /tmp/digest.md; then
      maybe_alert "feedflag $(hostname): digest generation FAILED ($MODE) — issue #5 will go stale. journalctl -u feedflag-digest.service"
      exit 1
    fi
    # Addendum: live govwait board from committed state (no keys needed).
    node --import tsx scripts/extract-wait-times.ts --report-only >> /tmp/digest.md 2>/dev/null || true
    # Authenticate by MINTING, not by reading a PAT (pizza-eagle#44/#45,
    # feedflag#67): `--purpose feedflag-digest` returns a 1h token scoped to
    # this repo with issues:write ONLY, needs no request-auth.json case file,
    # and leaves no durable secret in /opt/feedflag/.env. The broker fetches
    # the App PEM from Secrets Manager per call, so the key never lands here.
    #
    # gh-token.mjs prints the TOKEN to stdout and metadata to stderr: capture
    # stdout only, send stderr to a log, and never echo the variable. This
    # script runs `set -uo pipefail` and must never gain `-x` on this path, or
    # the token lands in the journal.
    PE_SCRIPTS=/opt/pizza-eagle/scripts
    PE_ENV=/etc/pizza-eagle/.env
    # GH_APP_ID lives in pizza-eagle's env (EnvironmentFiles= on
    # pizza-eagle.service). Read it; do NOT duplicate it into
    # ptp/prod/feedflag/env — two copies of the same id is how they drift.
    PE_APP_ID="${GH_APP_ID:-$(grep -m1 -oE '^GH_APP_ID=.*' "$PE_ENV" 2>/dev/null | cut -d= -f2- | tr -d "\"'")}"
    DIGEST_TOKEN=""
    if [ -n "$PE_APP_ID" ] && [ -x "$PE_SCRIPTS/gh-token.mjs" ]; then
      DIGEST_TOKEN=$(cd "$PE_SCRIPTS" && GH_APP_ID="$PE_APP_ID" node gh-token.mjs \
        --repo "$FEEDFLAG_REPO_SLUG" --purpose feedflag-digest 2>>/tmp/digest-mint.log) || DIGEST_TOKEN=""
    fi
    if [ -z "$DIGEST_TOKEN" ]; then
      maybe_alert "feedflag $(hostname): digest MINT FAILED ($MODE) — no 1h issues:write token from $PE_SCRIPTS/gh-token.mjs --purpose feedflag-digest (GH_APP_ID read from $PE_ENV). Digest was built but NOT posted; issue #5 will go stale. See /tmp/digest-mint.log and journalctl -u feedflag-digest.service"
      exit 1
    fi
    # curl is the primary path: `gh` is NOT installed on this box (verified
    # 2026-10-30 — curl, jq, flock, python3 and node are; gh is absent), so the
    # old `gh issue comment` branch was unreachable in practice and is gone
    # rather than kept as dead code nobody exercises.
    COMMENT_URL=$(curl -s -m 15 -X POST \
      -H "authorization: Bearer $DIGEST_TOKEN" \
      -H "content-type: application/json" \
      -d "$(jq -n --arg body "$(cat /tmp/digest.md)" '{body: $body}')" \
      "https://api.github.com/repos/${FEEDFLAG_REPO_SLUG}/issues/${FINDINGS_ISSUE}/comments" 2>/dev/null \
      | jq -r '.html_url // empty') || true
    DIGEST_TOKEN=""   # drop the reference as soon as it is used
    if [ -z "$COMMENT_URL" ]; then
      maybe_alert "feedflag $(hostname): digest comment post FAILED ($MODE) — token minted but the API rejected the comment; digest built, issue #5 + Slack mirror skipped. Check the broker purpose feedflag-digest, the repo slug, and curl/jq on the bastion."
      exit 1
    fi
    echo "[timer] digest comment posted: $COMMENT_URL"
    if [ -n "$SLACK_WEBHOOK_URL" ]; then
      # Slack mirror with the comment link (same shape as the workflow step:
      # JSON payload so flagged thumbnails ride via attachments.image_url).
      if node --import tsx scripts/digest.ts --hours 26 --slack --source db > /tmp/slack-digest.json 2>/dev/null \
         && jq -e '.text' /tmp/slack-digest.json >/dev/null 2>&1; then
        jq --arg u "$COMMENT_URL" '.text += "\nDetails: " + $u | .icon_emoji = ":feedflag:"' /tmp/slack-digest.json > /tmp/slack-payload.json 2>/dev/null \
          && curl -s -m 10 -o /dev/null -X POST -H 'content-type: application/json' \
               --data-binary @/tmp/slack-payload.json "$SLACK_WEBHOOK_URL" \
          || maybe_alert "feedflag $(hostname): digest Slack mirror FAILED ($MODE) (non-fatal — issue #5 comment posted: $COMMENT_URL)"
      else
        maybe_alert "feedflag $(hostname): digest Slack payload build FAILED ($MODE) (non-fatal — issue #5 comment posted: $COMMENT_URL)"
      fi
    fi
    echo "[timer] digest done head=$DEPLOY_SHA"
    exit 0
    ;;
  reactions)
    # Issue #31: hourly at :20 — bastion port of the feedflag.yml "Collect
    # Slack reactions" step (unchanged scripts/collect-reactions.ts). 👍/👎
    # in the flag channels append to data/labels.jsonl — the corpus the
    # digest uses to exclude wrong-verdict flags, so without this leg the
    # human feedback loop dies. Voting-hours gate (same IN_WINDOW as
    # peak/social — reactions only accrue while flags are posting) at the
    # :20 offset so it never lands on the busy :0/:15/:30 marks.
    if IN_WINDOW; then
      restore_state
      echo "[timer] reactions: collecting Slack 👍/👎 labels"
      node --import tsx scripts/collect-reactions.ts
    else
      echo "reactions: outside voting hours ($(date -u +%H) UTC)"
      exit 0
    fi
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 1 ;;
esac
RUN_RC=$?

# ---- post: emit to DB (box runs reach feed_observations), then state ------
if [ $RUN_RC -ne 0 ]; then
  maybe_alert "feedflag $(hostname): $MODE run FAILED (rc=$RUN_RC) — pipeline leg down. journalctl -u feedflag-$MODE.service on the bastion."
else
  if node --import tsx scripts/emit-to-db.ts --hours 4; then
    rotate_observations
  else
    maybe_alert "feedflag $(hostname): emit-to-DB TOTAL FAILURE ($MODE) — observations NOT reaching feed_observations. Check PIZZABASE_API_* + API health."
  fi
fi
push_state
heartbeat
echo "[timer] $MODE done rc=$RUN_RC head=$DEPLOY_SHA"
exit $RUN_RC