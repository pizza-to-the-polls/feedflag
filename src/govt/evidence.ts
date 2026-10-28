/**
 * Evidence guard for govt wait-time observations (issue #20).
 *
 * Incident: 2026-10-28 17:28:35 UTC the govwatch GitHub Actions backup ran
 * PRE-GATE code checked out from the stale `data` branch (merge-base with
 * main was 2026-10-24, before PR #16 landed the freshness/hours gates) and
 * re-posted the frozen Clark NV wait values to the volunteer feed at 95%
 * confidence. The rows that landed in feed_observations carried
 * `description = {}` — every observation written by the gated code carries a
 * full raw-REST evidence block (method, rawWaitTime, lastRefresh,
 * frozenCount, stale, outsideHours, hoursReason, sourceUrl) — so an EMPTY
 * evidence block is the pre-gate-code signature.
 *
 * Belt-and-braces (issue #20 fix 3): both ends of the govt observation path
 * refuse evidenceless rows so a stale-code writer can never silently
 * re-inflate confidence onto the bus or the DB:
 *   - writer:   scripts/extract-wait-times.ts (observation bus append)
 *   - consumer: scripts/emit-to-db.ts         (feed_observations POST)
 *
 * Pure and dependency-free — scripts/test-data-branch.ts exercises it
 * against the real incident row shapes.
 */

/** true when `description` carries a non-empty evidence object — the
 *  contract every govt observation writer has had since the issue-#12 gates
 *  landed (PR #16). Pre-gate code emits `description: {}` (or omits the
 *  block entirely), which fails this check.
 *
 *  Deliberately shallow: the contract is "evidence exists and is
 *  non-empty", not "evidence contains specific REST fields" — text/vision
 *  extraction paths legitimately carry null rawWaitTime/lastRefresh, and a
 *  presence check can never false-positive on them. */
export function hasGovtEvidence(description: unknown): boolean {
  if (description == null || typeof description !== "object") return false;
  const ev = (description as { evidence?: unknown }).evidence;
  if (ev == null || typeof ev !== "object" || Array.isArray(ev)) return false;
  return Object.keys(ev).length > 0;
}
