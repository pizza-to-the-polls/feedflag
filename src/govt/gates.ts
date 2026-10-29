/**
 * Freshness + hours gates for govt wait-time readings (issue #12).
 *
 * Clark NV, 2026-10-26 08:13 PT: the REST path posted
 * "W Flamingo Sr Ctr: 65 min — 95%" while the county's own locator card for
 * the same site read "Current Wait Time: N/A". The raw WAIT_TIME field had
 * been frozen at 65 across every observation since the source went live
 * (60 of 61 tracked sites frozen) — the field is not live data — and the
 * post fired 47 minutes before the site's 09:00 opening. The county's public
 * app applies display logic (staleness detection, hours-awareness) on top of
 * the raw field, so raw-field ≠ what a human sees.
 *
 * These gates replicate that display logic upstream of the volunteer feed:
 *
 *  - Freshness gate: a wait value unchanged across N consecutive runs
 *    (~30 min apart per cron) is a frozen field, not a live queue —
 *    confidence drops below the eval floor and the reading never vol-posts.
 *  - Hours gate: readings observed outside a site's hours of operation are
 *    recorded (state + observation bus) but never posted to Slack.
 *  - Evidence: raw REST field values + gate verdicts ride on every reading
 *    so audits don't need to re-query the source.
 *
 * Everything here is pure (clock injectable) — scripts/test-govwatch.ts
 * exercises it against the real incident's numbers.
 */

/** Consecutive runs a wait value must stay identical before it is treated
 *  as a frozen (stale) field. Runs are cron-spaced ~30 min (govwatch
 *  workflow), so 3 runs ≈ 90 min of flatline — a live queue reading that
 *  never moves for 90 min on a polling day is not live data (Clark: frozen
 *  5 days). Kept small so a stale field trips within one morning. */
export const FRESHNESS_FROZEN_RUNS = 3;

/** Confidence ceiling for stale-flagged readings — under the 0.6
 *  evaluateReading dispatch floor so a stale reading can never dispatch
 *  even if routing changes later. */
export const STALE_CONFIDENCE = 0.2;

/** Confidence ceiling for outside-hours readings. The number is what the
 *  API says, but no human can see it rendered pre-open — half-weight
 *  evidence, still under the 0.6 dispatch floor. */
export const OUTSIDE_HOURS_CONFIDENCE = 0.5;

/** How long an inactive (vanished-site) state entry is kept before pruning:
 *  the county adds/removes rows between runs (Clark shrank 61 → 36
 *  mid-window); a re-added row should still find its history for a week. */
export const INACTIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-site tracking record persisted to data/govt-readings.json. The
 *  issue-#12 fields are optional so pre-gate state files load unchanged. */
export interface ReadingState {
  minutes: number | null;
  category: string | null;
  updated: string | null;
  confidence: number;
  at: string;
  address?: string | null;
  /** Raw REST wait field value (unparsed) — evidence trail */
  rawWaitTime?: number | string | null;
  /** Raw REST last-refresh field value (unparsed) — evidence trail */
  lastRefresh?: number | string | null;
  /** Consecutive runs the wait value has been unchanged, incl. this run */
  frozenCount?: number;
  /** false = the source no longer returns this site (row removed county-side) */
  active?: boolean;
}

// ── Freshness gate ─────────────────────────────────────────────────────────

/** Minimal slice of previous-run state the freshness gate needs. */
export interface FreshnessPrev {
  minutes?: number | null;
  frozenCount?: number;
}

export interface FreshnessVerdict {
  /** Consecutive runs the value has been unchanged, including this one */
  frozenCount: number;
  /** true when frozenCount >= FRESHNESS_FROZEN_RUNS */
  stale: boolean;
}

/** Freshness gate: compare this run's wait value against the previous
 *  run's. Identical value → frozenCount++; ≥ FRESHNESS_FROZEN_RUNS → stale.
 *  Any change (or a first-ever observation, or a null value) resets to 0.
 *  Crossing an open→closed boundary needs no special case: an overnight-
 *  frozen field keeps counting, which is the desired behavior. */
export function nextFreshness(
  current: number | null,
  prev: FreshnessPrev | undefined,
): FreshnessVerdict {
  const prevVal = prev?.minutes ?? null;
  if (!prev || current == null || prevVal == null || current !== prevVal) {
    return { frozenCount: 0, stale: false };
  }
  const frozenCount = (prev.frozenCount ?? 0) + 1;
  return { frozenCount, stale: frozenCount >= FRESHNESS_FROZEN_RUNS };
}

/** Confidence a reading should carry given its freshness verdict. */
export function freshnessConfidence(
  base: number,
  verdict: FreshnessVerdict,
): number {
  return verdict.stale ? Math.min(base, STALE_CONFIDENCE) : base;
}

// ── Hours gate ─────────────────────────────────────────────────────────────

export interface HoursWindow {
  openMin: number;
  closeMin: number;
}

/** Parse a "HH:MM-HH:MM" hours spec into minutes-since-midnight bounds.
 *  Returns null on any malformed input (callers fail open). */
export function parseHoursWindow(spec: string): HoursWindow | null {
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const oh = Number(m[1]);
  const om = Number(m[2]);
  const ch = Number(m[3]);
  const cm = Number(m[4]);
  if (oh > 23 || ch > 23 || om > 59 || cm > 59) return null;
  return { openMin: oh * 60 + om, closeMin: ch * 60 + cm };
}

/** Minutes-since-midnight for `now` in `timeZone` (IANA), or null when the
 *  zone is unknown (callers fail open — misconfig must never suppress live
 *  data). Uses hourCycle h23 so midnight is "00", never ICU's "24". */
export function localMinutesOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}

export interface HoursVerdict {
  open: boolean;
  /** Set when the verdict is informative: why the site counts as closed, or
   *  why the gate failed open (config problem). */
  reason?: string;
}

/** Hours gate: is `now` inside the site's hours of operation? Unknown or
 *  unparseable config fails OPEN (no gate) so a bad hours spec or IANA zone
 *  can never suppress live readings. A window whose close time is ≤ its
 *  open time (e.g. "20:00-02:00") is treated as crossing midnight. */
export function isWithinHours(
  hoursSpec: string,
  timeZone: string,
  now: Date = new Date(),
): HoursVerdict {
  const w = parseHoursWindow(hoursSpec);
  if (!w)
    return { open: true, reason: `unparseable hours spec "${hoursSpec}"` };
  const mins = localMinutesOfDay(now, timeZone);
  if (mins == null)
    return { open: true, reason: `unknown timezone "${timeZone}"` };
  const open =
    w.closeMin <= w.openMin
      ? mins >= w.openMin || mins < w.closeMin // crosses midnight
      : mins >= w.openMin && mins < w.closeMin; // close is exclusive
  if (open) return { open };
  return {
    open,
    reason: `outside hours of operation (${hoursSpec} ${timeZone}; local ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")})`,
  };
}

// ── Per-field helpers (issue #12 root cause, 2026-10-29) ───────────────────

/** Wait-minutes from a REST seconds field. Clark NV's live field is
 *  WAIT_TIME_secs (ticks with Last_Refresh; the county card's
 *  "Approximately N minutes" is secs/60) while its WAIT_TIME minutes field
 *  has been dead since Oct 21 — the extractor read the dead one, so every
 *  Clark reading was 0 or frozen-stale while the county card showed live
 *  numbers (Hend City Hall: card 60 min, REST WAIT_TIME 0, secs 3600).
 *  Rounds to whole minutes with the same 0..600 sanity bound as minutes
 *  fields. Null on missing/negative/non-numeric — a null seconds field
 *  means "not reporting right now" (the county card renders N/A) and must
 *  never fall back to a dead minutes field. */
export function waitMinutesFromSeconds(secs: unknown): number | null {
  // Number(null)/Number("") are 0 — a missing/blank field must read as
  // "not reporting" (null), not a zero-minute line.
  if (
    secs == null ||
    (typeof secs === "string" && secs.trim() === "")
  )
    return null;
  const n = typeof secs === "number" ? secs : Number(secs);
  if (!Number.isFinite(n) || n < 0) return null;
  const minutes = Math.round(n / 60);
  return minutes > 600 ? null : minutes;
}

/** Per-site hours-of-operation fields → an "HH:MM-HH:MM" spec for the hours
 *  gate. Clark rows carry START_TIME "08:00:00.0000000" / END_TIME
 *  "17:00:00.0000000" (24-hour SQL time strings) — Hend City Hall runs
 *  08:00-17:00, not the 09:00-18:00 county-wide default the gate used to
 *  assume. Takes the leading HH:MM of each side. Returns null when either
 *  side is missing, non-string, or carries an AM/PM marker (a "05:00 PM"
 *  close would silently build a midnight-crossing window — fail to the
 *  source default instead; callers fail open on null). */
export function hoursSpecFromFields(
  open: unknown,
  close: unknown,
): string | null {
  const hhmm = (v: unknown): string | null => {
    if (typeof v !== "string" || /am|pm/i.test(v)) return null;
    const m = v.trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : null;
  };
  const o = hhmm(open);
  const c = hhmm(close);
  return o && c ? `${o}-${c}` : null;
}

// ── Site-removal tolerance ─────────────────────────────────────────────────

/** Sites a REST source no longer returns are marked inactive rather than
 *  silently deleted (the county adds/removes rows between runs — Clark's
 *  layer shrank 61 → 36 mid-window). Inactive entries past INACTIVE_TTL_MS
 *  are pruned entirely. Only call this when the source returned a real
 *  result set this run: a failed/empty fetch must never mark sites inactive.
 *  Mutates `next`. Returns the keys newly marked inactive. */
export function markVanishedSites(
  sourceUrl: string,
  state: Record<string, ReadingState>,
  next: Record<string, ReadingState>,
  seenKeys: ReadonlySet<string>,
  now: Date = new Date(),
): string[] {
  const prefix = `${sourceUrl}#`;
  const marked: string[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(prefix) || seenKeys.has(k)) continue;
    if (v.active === false) {
      const age = now.getTime() - Date.parse(v.at);
      if (Number.isFinite(age) && age > INACTIVE_TTL_MS) continue; // pruned
      if (!(k in next)) next[k] = v;
      continue;
    }
    next[k] = { ...(next[k] ?? v), active: false };
    marked.push(k);
  }
  return marked;
}
