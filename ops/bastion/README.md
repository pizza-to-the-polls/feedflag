# feedflag on the bastion (ops box)

Primary scheduler (GitHub Actions is the 30-min backup). systemd timers on
`pizza-eagle` (i-014e949a7ddbfdb19, AL2023 ARM, Node 24):

| timer | cadence | gate |
|---|---|---|
| `feedflag-govwatch.timer` | `*:0/30` 24/7 | none |
| `feedflag-peak.timer` | `*:0/15` | hour in 12:00–03:59 UTC (7am–11pm ET, voting hours) → govwatch extraction |
| `feedflag-social.timer` | `*:0/15` | same hour gate → social pipeline |
| `feedflag-hot.timer` | `*:0/15` | date 2026-11-02..04 → govwatch extraction (hot mode) |

Net cadence: **govwatch 15-min during voting hours / 30-min overnight; social
15-min during voting hours** (2026-10-27 user call).

- `run-timer.sh` ff-pulls `main` each fire (main is ruleset-protected, code
  only) so fixes propagate within one tick; local `data/` state never
  overlaps code diffs. `.env` from Secrets Manager `ptp/prod/feedflag/env`
  (BotRole `triage-readonly` grants `ptp/prod/feedflag/*`).
- Setup: `aws ssm send-command` with base64'd script (quoting-safe); unit
  files in `/etc/systemd/system/`; see git history of this dir for sources.
- Dedupe (seen.json + ON CONFLICT + change-detection) makes overlapping
  runs with GH Actions harmless.
