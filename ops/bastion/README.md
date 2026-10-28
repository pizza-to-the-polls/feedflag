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

- `run-timer.sh` ff-pulls `main` each fire (main is ruleset-protected, code
  only) so fixes propagate within one tick; local `data/` state never
  overlaps code diffs. `.env` from Secrets Manager `ptp/prod/feedflag/env`
  (BotRole `triage-readonly` grants `ptp/prod/feedflag/*`).
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
