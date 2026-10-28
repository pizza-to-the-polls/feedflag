# feedflag on the bastion (ops box)

Primary scheduler (GitHub Actions is the 30-min backup). systemd timers on
`pizza-eagle` (i-014e949a7ddbfdb19, AL2023 ARM, Node 24):

| timer | cadence | gate |
|---|---|---|
| `feedflag-peak.timer` | `*:0/15` | hour in 12:00–03:59 UTC (7am–11pm ET, voting hours) → govwatch extraction — **the only govwatch path** (2026-10-27: overnight baseline disabled; polls closed = dead time) |
| `feedflag-social.timer` | `*:0/15` | same hour gate → social pipeline |
| `feedflag-hot.timer` | `*:0/15` | date 2026-11-02..04 → govwatch extraction (hot mode) |

Net cadence: **govwatch + social both 15-min during voting hours only;
overnight both dark** (2026-10-27 user call — no polling when polls are
closed). Nov 2–4 hot mode: 15-min 24/7, date-guarded.

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
in `data/` and `.env` — both are in `.gitignore` and are never touched by `git reset
--hard`. Code and config files are deployed artifacts, not generated content.

**One-run deploy lag:** a PR pushed to `origin/main` is deployed on the next timer fire
(at most 15 minutes later). The currently-running fire executes whatever was deployed
at fetch time — that's intentional and has no adverse effect because state is pushed
independently via `ops/state-push.sh`.

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
  files in `/etc/systemd/system/`; see git history of this dir for sources.
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
