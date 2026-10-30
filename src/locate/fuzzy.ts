/**
 * Deterministic fuzzy prefilter over pizzabase `locations` (issue #35).
 *
 * Pure: normalized Jaro-Winkler similarity between the observation's
 * extracted place mentions and each candidate row's name/address, scoped by
 * the caller to the observation's county/state. Output is a top-K ranked
 * candidate list (K ≤ 25 — Jev's choice cardinality guard); the deterministic
 * chain resolves unambiguous picks here so most posts never need a model call.
 */
import {
  confidenceFromScore,
  jaroWinkler,
  normalizePlaceName,
} from "./similarity.js";
import type {
  CandidateLocation,
  LocationRow,
  ResolvedLocation,
} from "./types.js";

/** Similarity floor for a row to count as a candidate. */
export const SIMILARITY_THRESHOLD = 0.85;
/** Score above which a winner is accepted without disambiguation. */
export const STRONG_MATCH_SCORE = 0.93;
/** Clear-winner gap over the runner-up (deterministic accept). */
export const WINNER_GAP = 0.05;
/** Top-K candidate cap. */
export const MAX_CANDIDATES = 25;

export interface ScoredLocation {
  row: LocationRow;
  score: number;
}

/** Name/address strings to score against for one row. */
export function rowNames(row: LocationRow): string[] {
  return [row.name, row.address, row.fullAddress ?? row.full_address]
    .filter((s): s is string => !!s?.trim())
    .map(normalizePlaceName)
    .filter(Boolean);
}

export function rowId(row: LocationRow): string {
  return row.id != null ? String(row.id) : (row.canonical_id ?? "");
}

export function rowAddress(row: LocationRow): string {
  return row.fullAddress ?? row.full_address ?? row.address ?? "";
}

/** Best normalized similarity between any mention and any row name/address. */
export function scoreLocation(mentions: string[], row: LocationRow): number {
  const names = rowNames(row);
  if (!names.length) return 0;
  let best = 0;
  for (const m of mentions) {
    const nm = normalizePlaceName(m);
    if (!nm) continue;
    for (const n of names) {
      const s = jaroWinkler(nm, n);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Ranked top-K candidates above the similarity threshold, best first. */
export function rankCandidates(
  mentions: string[],
  rows: LocationRow[],
  opts: { threshold?: number; limit?: number } = {},
): ScoredLocation[] {
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const limit = opts.limit ?? MAX_CANDIDATES;
  const best = new Map<string, ScoredLocation>();
  for (const row of rows) {
    const score = scoreLocation(mentions, row);
    if (score < threshold) continue;
    const key = rowId(row) || rowAddress(row);
    const cur = best.get(key);
    if (!cur || score > cur.score) best.set(key, { row, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** True when the top candidate is strong enough to accept without a
 *  disambiguation call: single survivor, or a clear gap over the runner-up. */
export function isClearWinner(ranked: ScoredLocation[]): boolean {
  const top = ranked[0];
  if (!top) return false;
  if (ranked.length === 1) return true;
  return (
    top.score >= STRONG_MATCH_SCORE &&
    top.score - ranked[1]!.score >= WINNER_GAP
  );
}

export function toCandidate(e: ScoredLocation): CandidateLocation {
  return {
    location_id: e.row.id != null ? e.row.id : rowAddress(e.row),
    name: e.row.name,
    address: rowAddress(e.row) || undefined,
  };
}

/** Additive resolved block from a scored/known row. */
export function resolvedFromRow(
  row: LocationRow,
  method: ResolvedLocation["method"],
  confidence: number,
): ResolvedLocation {
  return {
    address: rowAddress(row) || undefined,
    location_id: row.id,
    canonical_id: row.canonical_id ?? undefined,
    name: row.name ?? undefined,
    method,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export function resolvedFromScore(
  e: ScoredLocation,
  method: "fuzzy" | "jev",
  opts: { confidence?: number; discount?: number } = {},
): ResolvedLocation {
  const base = opts.confidence ?? confidenceFromScore(e.score);
  const conf = opts.discount ? base * opts.discount : base;
  return resolvedFromRow(e.row, method, Math.min(0.95, conf));
}
