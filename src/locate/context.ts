/**
 * Recent-context for location disambiguation (issue #35).
 *
 * What the same author/source has recently been observed discussing is both:
 * - a SCOPE source for the social leg (which observations have no
 *   county/state of their own), and
 * - a TIEBREAKER among equally-scored fuzzy candidates.
 *
 * Default provider reads feedflag's own observation bus
 * (data/observations.jsonl) — the same append-only stream the pipeline and
 * the govt extractor write. Read-only, local, no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../config.js";
import { WINNER_GAP, type ScoredLocation } from "./fuzzy.js";
import type { LocationScope, Observation, ResolvedLocation } from "./types.js";
import type { ContextProvider } from "./types.js";

export const CONTEXT_WINDOW_HOURS = 24;
export const CONTEXT_LIMIT = 20;

/** Scope (state/county) of the author's most recent located observation. */
export function contextScope(recent: Observation[]): LocationScope {
  for (const o of recent) {
    const state = o.location?.state;
    if (state) return { state, county: o.location?.county };
  }
  return {};
}

/** The most recent real resolution in the author's history (skip no-match). */
export function contextResolved(recent: Observation[]): ResolvedLocation | null {
  for (const o of recent) {
    const r = o.location?.resolved;
    if (r && r.method !== "no-match") return r;
  }
  return null;
}

/**
 * Recent-context tiebreaker: when the score table is genuinely ambiguous
 * (the context candidate is within WINNER_GAP of the top score), prefer the
 * place this author/source has recently been observed discussing. Returns
 * the candidate to accept, or null when history isn't decisive (candidate
 * not ranked, or the leader is a clear winner on its own merits).
 */
export function applyContextTiebreak(
  ranked: ScoredLocation[],
  resolved: ResolvedLocation,
): ScoredLocation | null {
  const ids = new Set<string>();
  if (resolved.location_id != null) ids.add(String(resolved.location_id));
  if (resolved.canonical_id != null) ids.add(String(resolved.canonical_id));
  if (!ids.size) return null;
  const idx = ranked.findIndex(
    (e) =>
      (e.row.id != null && ids.has(String(e.row.id))) ||
      (e.row.canonical_id != null && ids.has(String(e.row.canonical_id))),
  );
  if (idx === -1) return null;
  const hit = ranked[idx]!;
  if (idx === 0) return hit;
  const top = ranked[0]!;
  // decisive only when history breaks a genuine tie — a clearly stronger
  // leader must not be overridden by history
  return top.score - hit.score <= WINNER_GAP ? hit : null;
}

function parseBus(path: string): Observation[] {
  if (!existsSync(path)) return [];
  const out: Observation[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Observation;
      if (o?.schema === "feedflag/observation@1") out.push(o);
    } catch {
      // skip malformed lines — the bus is an append-only audit stream
    }
  }
  return out;
}

/** Recent observations by the same author (or source_ref) off the local bus,
 *  newest first, inside the context window. Small TTL cache — the bus is
 *  appended-to during a run but per-run freshness beyond this is moot.
 *  `busPath` overrides the default bus location (tests inject fixtures). */
export class LocalBusContextProvider implements ContextProvider {
  private cache?: { at: number; obs: Observation[] };
  private ttlMs = 30_000;

  constructor(private busPath?: string) {}

  async recentObserved(author: string, limit = CONTEXT_LIMIT): Promise<Observation[]> {
    if (!author) return [];
    const now = Date.now();
    if (!this.cache || now - this.cache.at > this.ttlMs) {
      const path = this.busPath ?? join(settings.dataDir, "observations.jsonl");
      try {
        this.cache = { at: now, obs: parseBus(path) };
      } catch {
        return []; // a bus read failure never blocks resolution
      }
    }
    const cutoff = new Date(
      now - CONTEXT_WINDOW_HOURS * 3600_000,
    ).toISOString();
    return this.cache.obs
      .filter((o) => o.author === author || o.source_ref === author)
      .filter((o) => (o.observed_at ?? "") >= cutoff)
      .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""))
      .slice(0, limit);
  }
}
