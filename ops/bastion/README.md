# feedflag on the bastion (ops box)

Primary scheduler (GitHub Actions is the 30-min backup). systemd timers on
`pizza-eagle` (i-014e949a7ddbfdb19, AL2023 ARM, Node 24):

| timer | cadence | gate |
|---|---|---|
| `feedflag-heartbeat.timer` | `*:0/15` | none (24/7) → CW heartbeat metric only |
| `feedflag-peak.timer` | `*:0/15` | hour in 12:00–03:59 UTC (7am–11pm ET, voting hours) → govwatch extraction — **the only govwatch path** (2026-10-27: overnight baseline disabled; polls closed = dead time) |
| `feedflag-govwatch.timer` | `*:0/30` | none (24/7) → ungated govwatch extraction |
| `feedflag-social.timer` | `*:0/15` | same hour gate → social pipeline |
| `feedflag-hot.timer` | `*:0/15` | date 2026-11-02..04 → govwatch extraction (hot mode) |
| `feedflag-digest.timer` | `*-*-* 02:00:00` | none (daily) → findings digest comment on issue #5 + Slack mirror (issue #31; the ONLY writer of issue #5) |
| `feedflag-reactions.timer` | `*:20` | hour in 12:00–03:59 UTC (same IN_WINDOW gate as social/peak) → collect Slack 👍/👎 labels into `data/labels.jsonl` (issue #31) |

Net cadence: **govwatch + social both 15-min during voting hours only;
overnight both dark** (2026-10-27 user call — no polling when polls are
closed). Nov 2–4 hot mode: 15-min 24/7, date-guarded.

**Issue #31 legs (bastion ports of the feedflag.yml steps that had no timer
equivalent — both went dark when the Actions schedule was disabled):**

- `feedflag-digest` — daily 02:00 UTC, `scripts/digest.ts --hours 26` +
  `extract-wait-times.ts --report-only` appended, posted as a comment on
  findings issue #5, mirrored to Slack with the comment URL. **Read-only**
  leg: consumes the state files the 15-min legs keep current, writes only
  to the issue + Slack — no `restore_state` / `push_state` / emit-to-DB.
- `feedflag-reactions` — hourly at :20 during voting hours, runs
  `scripts/collect-reactions.ts` unchanged. Appends to the box's live
  `data/labels.jsonl` (and its `data/reactions-sync.json` cursor), so it
  DOES `restore_state` + `push_state` + emit — same state contract as the
  pipeline legs. The digest excludes wrong-verdict flags via that corpus,
  so this leg is what keeps the human feedback loop alive.

Deploy both (after the templates land in `/etc/systemd/system/` and
`FEEDFLAG_DIGEST_TOKEN` is in `.env`):
```
systemctl daemon-reload
systemctl enable --now feedflag-digest.timer feedflag-reactions.timer
systemctl list-timers 'feedflag-*'   # both new units listed
# Manual digest fire (dry check before 02:00 UTC):
systemd-run --unit=feedflag-digest-test /opt/feedflag/ops/bastion/run-timer.sh digest
journalctl -u feedflag-digest-test   # expect "[timer] digest comment posted: <url>"
```

## Deploy model (issue #22)

`run-timer.sh` updates code at the start of every timer fire:

1. **Fetch** `origin/main` (quiet).
2. **Fast-forward** `HEAD` to `origin/main` via `git merge --ff-only`. If the local
   `main` has diverged (pre-#21 state commits), this would fail — so we check first:
   if `HEAD` is not an ancestor of `origin/main`, or if `merge --ff-only` fails, the
   script runs **`git reset --hard origin/main`** (the safe self-heal).
3. **Post-deploy assertion**: if `HEAD != origin/main` after the pull, `maybe_alert`
   fires with the remediation command.

**Why `reset --hard` is safe:** the only mutable content the pipeline produces lives
in `data/` and `.env`. `.env` is gitignored and never touched by reset. The `data/*`
state files were (force-)**tracked** on `main` until this PR untracked them
(`git rm --cached` — state exists only on `refs/heads/data`), so a bare
`reset --hard` WOULD have reverted live box state to `main`'s stale blobs.
`heal_deploy()` therefore wraps the reset in a backup/restore of `data/` — safe
through the untracked transition tick and against any future regression. Code
files are deployed artifacts, not generated content.

**State push credential (2026-10-28, found during the unstick; closed same day):**
the box's `push_state` used to mint a token via
`/opt/pizza-eagle/scripts/gh-token.mjs`, which CANNOT mint from the timer
context (the pizza-eagle listener must inject `GH_APP_ID` and write a
`request-auth.json` write-gate) — so the box's state push silently never fired
its whole life; every `refs/heads/data` commit was a GH Actions run. The fix:
`FEEDFLAG_STATE_PUSH_TOKEN` — a scoped fine-grained PAT (contents:write,
`pizza-to-the-polls/feedflag` only) stored in Secrets Manager
`ptp/prod/feedflag/env` and landed in `/opt/feedflag/.env`. `push_state` uses it
first (basic `x-access-token` extraheader — same plumbing as App tokens) and
keeps `gh-token.mjs` as a fallback; a missing token still `maybe_alert`s loudly
(throttled 1h). Rotation: mint a new PAT, merge it into the secret, re-sync
`/opt/feedflag/.env` on the bastion (`jq -r 'to_entries[] | "\(.key)=\(.value)"'`
of the secret JSON into the dotenv file), revoke the old PAT.

**Digest credential (issue #31, `FEEDFLAG_DIGEST_TOKEN`):** the digest
leg's `gh issue comment` on findings issue #5 needs its own scoped
fine-grained PAT — **issues:write** on `pizza-to-the-polls/feedflag`
ONLY. Neither existing token covers it: `gh-token.mjs` cannot mint from
the timer context (listener write-gate, issue #22 notes) and
`FEEDFLAG_STATE_PUSH_TOKEN` is contents:write (git operations only).
Same lifecycle as the state-push token: store in Secrets Manager
`ptp/prod/feedflag/env`, land in `/opt/feedflag/.env`, rotate by minting
→ merging into the secret → re-syncing the dotenv → revoking the old
PAT. A missing token is caught by the runner's LOUD boot validation
(exit 1 + throttled Slack alert), never a silent dark digest. The
`reactions` leg needs no new credential (`SLACK_BOT_TOKEN` +
`SLACK_FLAG_CHANNELS` are already in the v5 REQUIRED list).

**ExecStart path: the TRACKED script only (issue #24).** Every `feedflag-*.service`
unit here must ExecStart the tracked runner at `ops/bastion/run-timer.sh`
(deployed on the box as `/opt/feedflag/ops/bastion/run-timer.sh`) — never an
untracked copy of the runner at the repo root on the box. An untracked root
copy is a silent-stale-code vector: `git pull` can never update it, so the box
keeps executing old runner code no matter what lands on `origin/main` (the
2026-10-28 re-wedge: a stale v5 root copy kept committing state onto local
`main` within 4 ticks of the manual unstick). If a unit points anywhere else,
the box is running stale code — fix it immediately. The unit files in this
directory are the sources of truth for `/etc/systemd/system/`; redeploy via
`aws ssm send-command` (quoting-safe base64'd script) + `systemctl daemon-reload`.

**Shared state vs the GH Actions backup (2026-10-28, the duplicate-flag fix):** the GH
Actions `feedflag` workflow runs the SAME social pipeline as a 30-min backup and
restores state from `refs/heads/data` at ITS start (issue #20). The bastion now does
the mirror-image `restore_state` before every pipeline leg: fetch the data branch,
per-file checkout + unstage (same as the workflow's restore step), retrying through
index-lock races with sibling units. Without it the two schedulers keep divergent
seen-stores and re-flag each other's posts — observed 2026-10-28 22:51 UTC:
@GretchenInOK flagged by the bastion at 21:30, re-flagged by the GH Actions backup
at 22:51 (duplicate post in #feed-lines) because the data branch's `seen.json`
lacked the id (the bastion state push was broken until PRs #26–#28 that same day).
Known trade-off: state pushes are whole-file overlays, so entries the OTHER writer
adds while both legs are in flight can be clobbered — the window is one run
(~1–4 min), `feed_observations` rows are the durable record (emit-to-DB), and a
rare lost `seen` entry only risks a rare duplicate, never data loss.

**One-run deploy lag:** a PR pushed to `origin/main` is deployed on the next timer fire
(at most 15 minutes later). The currently-running fire executes whatever was deployed
at fetch time — that's intentional and has no adverse effect because state is pushed
independently via `ops/state-push.sh` (see the credential-gap note above).

**One-time manual unstick** (2026-10-28 pre-#21 wedged checkout): if a box somehow
lands with a local commit on `main` that origin lacks (pre-#21 state commits, or manual
`git commit` on the box), the self-heal path resets automatically on the next timer
fire. To verify: `git log --oneline origin/main..HEAD` on the bastion should be empty.
If the self-heal doesn't fire (e.g., `git fetch` itself is broken), the manual
remediation is:
```
git fetch origin main && git reset --hard origin/main
```
This is idempotent; safe to re-run.

**Guard rail:** no code path in `run-timer.sh` ever commits to the local `main` branch.
All state persistence goes through `ops/state-push.sh` (plumbing-only, remote-branch
commits). Any `git add -f data` or `git commit` in the runner is a regression.

`.env` from Secrets Manager `ptp/prod/feedflag/env` (BotRole `triage-readonly` grants
`ptp/prod/feedflag/*`).
- Setup: `aws ssm send-command` with base64'd script (quoting-safe); unit
  files in `/etc/systemd/system/` are deployed from the templates in this
  directory (source of truth — see "ExecStart path" above), then
  `systemctl daemon-reload` + `systemctl enable --now` each new timer
  (feedflag-digest + feedflag-reactions, issue #31).
- Dedupe (seen.json + ON CONFLICT + change-detection) makes overlapping
  runs with GH Actions harmless.

## Observability (2026-10-27 postmortems: emit-dead-4-days, GH-drops-90%)

| Signal | Catches | Path |
|---|---|---|
| **CW `Feedflag/Heartbeat`** | box down / systemd dead / timer stall | runner posts every fire; **alarm `feedflag-heartbeat-dead`** (missing >30min = breach) → SNS `feedflag-alerts` (subscribe your email in console) |
| **DB freshness watchdog** (`.github/workflows/feedflag-watchdog.yml`) | ANY chain stop: timer → extraction → emit → DB | GH Actions (independent infra) checks newest `feed_observations` row age hourly during voting/Nov 2-4 windows; >45 min stale → Slack |
| **Loud boot** (runner v5) | missing env (the 4-day emit death) | runner exits 1 + Slack alert on ANY empty required var |
| **emit hard-fail** (`scripts/emit-to-db.ts`) | API/auth down while runs continue | sent>0 && inserted==0 → exit 1 → runner alert (throttled 1h) |
| **workflow failure jobs** | GH Actions run failures | all 3 workflows append an `alert` job → Slack on failure |

The watchdog is GH-side **because** the box can't witness its own death; CW alarm is AWS-side.
Both feed Slack; the SNS email is the only passive path that works with Slack itself down.
