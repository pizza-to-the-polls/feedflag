# feedflag retrospective — v1 (2026-10-17 → 2026-11-04)

Sources: `origin/main` history (181 commits, 50 merged PRs), prod DB
(`feed_observations`, 2,015,817 rows), `intents/` + the triple-helix plan,
the dead-man-switches postmortem commit (fb7a5bf), `ops/bastion/` units,
the Findings digest comments (issue #5), vendor billing APIs (OpenRouter,
Apify), and the operator's own post-mortem call (2026-11-05): four gaps,
listed verbatim below.

## The arc

Built in **19 days** for one deadline. Designed Oct 17 (TECHNICAL_DESIGN
draft, FEAT-002 epic: "social feed reader + JEV classifier"), first prod
rows Oct 23, election day Nov 3, last rows Nov 4. The project **pivoted
mid-flight**: started as "read IG/X/TikTok, classify with Jev, post flags to
Slack" and became, under election-week pressure, a nationwide **government
wait-time polling machine** (ArcGIS/Esri REST scrapers → observation bus →
pizzabase) — with the social leg still running alongside it.

## The numbers

- **50 merged PRs** in 19 days: dd-agent 21, mojowen (operator) 21,
  pizza-eagle 8. **54 of 181 commits are fix/revert**, 3 labeled HOTFIX.
- **2,015,817 observations**: 2,011,242 govt wait-time readings (99.9%),
  ~5,900 social (2,252 IG / 1,278 X / 508 TikTok), **536 crowd reports**
  (ground truth), 1 smoke. Peak day Nov 3: **501,871 rows**.
- **44 gov sources on the vol feed board** at the end (PA 8, TX 13, NC 11,
  NV 3, WI 5, AZ 5); 49 graduated on election eve; 3,625 distinct site refs
  ever polled.

## The spend (actuals, from vendor APIs on 2026-11-04)

**Apify — $112.26 metered**, all on the SCALE plan ($199/mo; the plan's
billing cycle started **2026-10-22 — the day feedflag went live**; metered
usage draws from the included $199 credits, so the plan is the real fixed cost):

| Actor | Leg | Runs | USD |
|---|---|---|---|
| apidojo~tweet-scraper | social (X) | 338 | $45.15 |
| apify~instagram-hashtag-scraper | social (IG) | 332 | $33.42 |
| moonweil~url-screenshot-api | govt (JS-wall fallback) | 5,335 | $26.67 |
| clockworks~tiktok-hashtag-scraper | social (TikTok) | 337 | $6.99 |
| instagram/tiktok-scraper (dev) | social | 10 | $0.03 |

**OpenRouter** — shared personal key: **$69.53 spent this week** against a
$500/wk guardrail, **$630 lifetime of $700 credits** — but account-wide
(pizza-eagle, clips, everything). Feedflag's attributable share ≈ 15–20M
flash-lite tokens (caption/classify, 5,335 screenshot vision extractions,
crowd normalizes, digests) ≈ **$3–6 total**.

**Everything else ≈ $0 marginal:** GH Actions (public repo), bastion
(existing box, systemd timers), Zapier (~400–500 catch-hook tasks —
flagged posts only), DB (~2M rows ≈ low-single-digit GB Aurora, cents/mo),
Slack webhooks/bot.

**Total ≈ $205 for the 19 days (~$10/day)** vs the ~$95/day the $350/wk
ceiling allowed. Budget was never the constraint. **The asymmetry is the
finding** — per useful signal:

| Leg | Spend | Output | Unit cost |
|---|---|---|---|
| social | ~$89 | ~200 poll_line flags | **$0.45 per actionable flag** |
| govt | ~$29 | 2.01M readings, 44 sources | **$0.000014 per reading** |
| crowd | ~$0 | 536 ground-truth reports | **$0** |

The social leg — the original product — burned **76% of the metered budget
for 0.3% of the rows and the weakest signal**; the govt pivot was ~30,000x
cheaper per observation. The plan renews 2026-11-21 — the social leg has to
earn its keep or go before then.

## What worked

1. **The observation bus.** One schema (`feedflag/observation@v1`) survived
   three heterogeneous producer legs (social, govt, crowd) plus emit to
   pizzabase, mid-election, without a migration.
2. **The govt-leg pivot (the discovery).** The election-week source sweep
   (PR #54: 43 new Esri REST sources; #68: graduate 36 verified on election
   eve) found a nationwide wait-time surface nobody had enumerated, and
   verification-before-graduation kept garbage off the vol feed.
3. **Crowd as ground truth.** 536 site-submitted reports, structured at
   capture (`confidence: 0.95`), no model in the loop. That corpus is v2's
   calibration set and it already exists.
4. **The triple helix retrofit (issues #37–44).** Harness + glob discovery
   closed the hole that let PR #36 ship 1,453 lines untested; `intents/`
   (11 module contracts) enforced in CI; the ratchet landed before E-Day;
   injectable settings/fs/transport + `PipelineDeps` seams. The suites caught
   agents ("agent test was right, formatter wasn't").
5. **The agent fleet process.** PR-gated (ruleset probed Oct 24 to *prove*
   direct pushes fail), operator merges, same-day hotfixes; pizza-eagle
   fixing feedflag's own bugs (#72, #73, #75).
6. **Dead-man switches from postmortems** (fb7a5bf): heartbeat CW metric +
   alarm, watchdog on independent infra ("the box cannot witness its own
   death"), emit TOTAL-FAILURE exits 1. The two big silent deaths — **emit
   dark 4 days** and **GH dropping ~90% of scheduled triggers** — bred
   these, and nothing died that way again.

## What didn't — the operator's four gaps, with the receipts

**1. "Never got high enough fidelity that we'd want these to auto push to
the volunteer feed."** The pipeline's whole reason to exist — machine flags
→ #feed-lines without a human in the loop — never happened. Every flag
route stayed human-gated: crowd reports → #feed-lines was **reverted as too
noisy** (21f6871, HOTFIX election week), and the social flags topped out at
~12/day in the *digest*, not the channel. Why the fidelity never got there:
the classifier ran the entire cycle on the flash-lite **fallback** (Jev
waitlist still pending), so confidences were **uncalibrated guesses** —
threshold 0.7 hand-picked, never measured; 35 manual labels + 2 correction
PRs to keep it honest, no systematic eval. The evaluation board (stress
test: actable? agrees? dispatchable?) was the right instrument — it read
**dispatchable: 0** on Nov 2, the day before the election, and there was
no time to fix what it told us.

**2. "Govt wait times very flaky, stopped working."** The flakiness was
structural, and it shows in the data: **pre-sweep (Oct 27–29) ~97% of
readings carried a live wait value** (9.8k of 10.1k/day, 8-state board);
**post-sweep (Oct 30 → E-Day) only ~24% did** (119k of 501k on Nov 3) —
of 3,094 distinct sites polled Nov 2–3, **936 (30%) ever produced a wait**.
The sweep added volume, not signal: ~70% of the polled surface was null
rows burning cadence, emit volume, and storage. Per-source rot between
verification and E-Day was the other half: Clark NV frozen **twice** (stale
REST #16, then dead-minutes-field root cause #48), Travis TX on the **wrong
Esri layer** (early-vote, would've stayed dark E-Day, #81 — found *by
hand the night before*), Augusta's broken app, Maricopa Apify-blocked, GA
sources muted whole for SB 22 (#75), board entries reading **0 readings**
(TX Tarrant, TX Dallas, NC Guilford at 1) while still occupying cadence
slots. Freshness/frozen gates caught some of this — but the default failure
mode was *quietly stale*, discovered by a human looking.

**3. "Auto identify polling place locations never worked."** The locate leg
(#35, triangulate every observation to a place) resolved essentially
nothing: of ~4,000 social observations, **2,203 resolved `no-match`
(confidence 0), 1,832 never resolved at all, and exactly 3 fuzzy-matched —
at conf 0.68.** A **0.07% resolution rate.** The 1,453 lines shipped with
no suite (the hole the helix retrofit exists to close), and the matcher had
nothing to match *against* — no polling-place registry, no gazetteer, just
fuzzy text matching social handles/captions to nothing. This is also why
gap #1 was fatal: a flag you can't place is a flag you can't dispatch a
pizza to, no matter how confident the classifier is.

**4. "Social identifier pretty mixed, did not improve, some gems."** Mixed
is measurable: ~80% `irrelevant`, ~12 flags/day, 35 labels of which most
were corrections, **$0.45 per actionable flag** — and *no improvement
mechanism ever existed*: the label corpus (labels.jsonl) and reaction
collector were built but **never fed back** into prompts, thresholds, or
categories. Same prompt, same threshold, day 19 as day 1. The gems were
real (poll_line_reports at 85–97% conf, delivery moments, press) — but
there was no loop that made week 3 better than week 1, so it stayed "mixed"
forever.

**And the systems-level failures underneath:**

- **State on a git branch** (`refs/heads/data`) cost six+ PRs of scar tissue:
  single-flight locks (#50), restore-before-every-leg (#29), base64
  line-wrap (#28), fetch-lock retry (#27), CI-vs-CI commit race, observation
  "resurrection loop" (#55), govwatch running pre-gate stale code and
  re-posting frozen Clark waits at 95% (#20/#21).
- **Emit couldn't carry govt volume**: 413 PayloadTooLarge drumbeat fixed
  twice (#32 chunk bisect, then #78 batch by serialized **bytes** — fat
  description blobs made any row-count guess wrong).
- **The digest read the wrong system**: it summarized `observations.jsonl`,
  which the runner gzips and empties after every emit — "last 26h" was one
  batch (#69); fixed by reading the DB (#70).
- **Ops metasystem fights itself**: anti-wedge cap killed the heartbeat
  2–4×/hr (#79); digest timeout too tight for election volume (#80);
  bastion deploy self-wedged on local commits (#22/#23); units ExecStart'd
  an untracked script (#24).
- **No cost telemetry ever landed** — README promised "cost telemetry
  (tokens/run) recorded"; `openrouter.ts` drops `usage` entirely. The
  intents declare weekly budgets and the gate sums the *declarations* ≤
  $350, but nothing measures actuals (election-week ingest ran ~$40/wk on
  the tweet scraper alone vs its declared $20). The whole ledger above was
  reconstructed from vendor APIs after the fact.
- **Loose ends**: `scripts/` never type-checked (#63), PR #82 open, issue #9
  (post-election hardening) open; the laptop checkout sat 8 days stale —
  box + DB are the source of truth now, git only carries code.

## What v2 looks like

Answer the four gaps first, then the systems:

1. **Fidelity program → then auto-push.** When the Jev waitlist lands,
   calibrate against the banked corpus (536 crowd reports + 35 labels +
   reactions). Then a **two-tier gate**: auto-push only what's measured
   (e.g. ≥90% precision against the labeled set, per category), everything
   else lands in a review queue (the digest). Auto-push is *earned by the
   eval*, not granted on vibes — and the eval is re-run every week because:
2. **Close the improvement loop.** Labels and reactions feed a weekly eval
   (precision per category per platform) that tunes prompts, categories,
   and thresholds. This is the single biggest thing v1 never did: the parts
   existed, nothing connected them. "Did not improve" is a v2 fixable with
   a cron and a script, not a research project.
3. **Govt: source health as first-class, null-weight budgeted.** The board
   becomes DB rows with a lifecycle (candidate → verified → graduated →
   **dead**), and a source that goes N days without a usable wait
   **auto-demotes itself** — the 70% null-weight surface stops being
   polled, instead of silently diluting everything. Schema contracts per
   source (pinned field mappings, like Clark's WAIT_TIME_secs) with a
   conformance check — Travis-style "wrong layer" drift should alarm, not
   be discovered by hand the night before. The freshness gates stay; they
   worked.
4. **Locate: stop inferring, start looking up.** Location resolution
   against a **polling-place registry** — pizzabase locations + county
   election-office directories + the Census LUT — not fuzzy LLM text
   matching. The govt legs already carry structured addresses (site +
   county); social observations resolve by the same lookup the govt sites
   do. Match rates should be 90%+, not 0.07% — and until the registry
   exists, don't ship a locate leg at all.
5. **Social demoted to discovery.** Its job is finding the gems (press,
   delivery moments, lines nobody reported) at a budget set **per useful
   flag**, with the same conformance discipline as govt sources (maxItems
   caps exist already). If it doesn't earn the $199 plan on that metric,
   cut it before the 2026-11-21 renewal — the govt leg proved the valuable
   surface was never social.
6. **DB-only state.** Retire `refs/heads/data` entirely: seen/deduge as a
   DB constraint or `seen` table, single-writer via the bastion runner,
   git carries code only. The whole single-flight/lock/race tier of
   postmortems evaporates.
7. **Delta storage.** Persist wait-time **changes** + periodic baseline per
   source, not every 15-min poll. 500k rows/day → thousands; emit 413
   pressure and #9's hardening mostly evaporate.
8. **Meter and gate real spend.** Capture `usage` from every OpenRouter
   call, tag by module, alert when actuals exceed the intents' declared
   `cost_per_week_usd_max` — the $350 gate should sum real money. (This
   retrospective's ledger cost $0 to reconstruct; it should have been a
   dashboard.)
9. **Ship the aggregator (Phase 4).** `/wait-times` API + public map on
   polls.pizza — the consumer every leg was built for, never built. The
   govt unit economics ($0.66/source/election) say a national board is
   rounding-error money; the flakiness record says source health (#3) is
   the prerequisite, not the API.
10. **Process: keep the helix + the fleet, add the postmortem→switch step
    explicitly.** PR-gated agents carried this project; the ratchet and
    intents held; fb7a5bf (dead-man switches) was the best commit of the
    cycle and every switch in it exists because something died quietly
    first. Make that the standing move.

**One-line version:** v1 proved the bus, the fleet, the sources, and the
budget (~$205 all-in, 10x under ceiling, govt 30,000x cheaper per signal
than social) — and proved that git-branch state, uncalibrated confidence,
unregistered locations, un-fed-back labels, and unmeasured costs don't
survive an election. v2 = calibrated + metered classification feeding an
auto-push gate it has *earned*, a source board with a lifecycle and
null-weight budgets, location by registry lookup, DB-only state, and the
public API that justifies all of it.