/**
 * Dependency-injection surface for the location-resolution chain (issue #35).
 *
 * The orchestrator (`src/locate/resolve.ts`) takes these as parameters, so
 * tests pin every resolution case with fixtures and no network. The default
 * wiring (`defaultResolveDeps`) talks read-only to pizzabase and the local
 * observation bus.
 */
import type { Observation, ResolvedLocation } from "../types.js";

/** Tolerant pizzabase `locations` row — snake_case or camelCase wire shape. */
export interface LocationRow {
  id?: number | string;
  name?: string;
  address?: string;
  fullAddress?: string;
  full_address?: string;
  city?: string;
  state?: string;
  county?: string;
  zip?: string;
  canonical_id?: string;
  lat?: number;
  lng?: number;
}

/** County/state scope constraining a location lookup. */
export interface LocationScope {
  state?: string;
  county?: string;
}

/** Registered govt source joined to its pizzabase location. */
export interface RegisteredSource {
  location_id: number | string;
  url?: string;
}

/** Exact registry link: `wait_time_sources.location_id` → `locations`. */
export interface RegistryProvider {
  findBySourceUrl(url: string): Promise<RegisteredSource | null>;
  getLocation(id: number | string): Promise<LocationRow | null>;
}

/** Read-only locations lookup, scoped when scope is available. */
export interface LocationProvider {
  listLocations(scope: LocationScope, limit: number): Promise<LocationRow[]>;
}

/** Recent observations by the same author/source — the disambiguation
 *  tiebreaker (what this author/feed has recently been observed discussing). */
export interface ContextProvider {
  recentObserved(author: string, limit: number): Promise<Observation[]>;
}

/** One fuzzy-matched candidate handed to Jev / the deterministic picker. */
export interface CandidateLocation {
  location_id: number | string;
  name?: string;
  address?: string;
}

/** Typed Jev decision for location disambiguation: string-in,
 *  typed-value-out — no prose, no generated strings (JEV_EXPLORATION.md). */
export interface LocationDecisionProvider {
  name: string;
  pick(
    text: string,
    candidates: CandidateLocation[],
  ): Promise<{ locationId: number | string | null; confidence: number }>;
}

export interface ResolveDeps {
  registry?: RegistryProvider;
  locations?: LocationProvider;
  context?: ContextProvider;
  jev?: LocationDecisionProvider;
  /** Top-K candidate cap (Jev choice cardinality guard). Default 25. */
  maxCandidates?: number;
}

/** Reused shapes: a scored candidate row + the shared ResolvedLocation. */
export type { Observation, ResolvedLocation };
