/**
 * Read-only pizzabase lookups for location resolution (issue #35).
 *
 * Strictly GET — the pipeline writes only its own observation rows, via the
 * existing emit path. Endpoints follow the same auth convention as
 * `src/ingest/reports.ts` (pizzabase checkAuthorization strips the
 * "Basic " prefix). Every method degrades on failure (null / []) so an
 * unavailable endpoint or a network hiccup can never block ingestion —
 * callers fall through to the deterministic chain and eventually no-match.
 *
 * Response parsing is tolerant (`{results, count}` / `{data}` / bare array —
 * the same house pattern as reports.ts), and `parse*` helpers are exported
 * pure for unit tests.
 */
import type {
  LocationRow,
  LocationScope,
  RegisteredSource,
  RegistryProvider,
  LocationProvider,
} from "./types.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** Tolerant list parser: pizzabase index() shapes + bare arrays. */
export function parseRowsJson(j: unknown): LocationRow[] {
  if (Array.isArray(j)) return j as LocationRow[];
  if (j == null || typeof j !== "object") return [];
  const o = j as Record<string, unknown>;
  const arr =
    (Array.isArray(o.results) && o.results) ||
    (Array.isArray(o.data) && o.data) ||
    (Array.isArray(o.locations) && o.locations) ||
    (Array.isArray(o.rows) && o.rows) ||
    (Array.isArray(o.wait_time_sources) && o.wait_time_sources) ||
    [];
  return arr as LocationRow[];
}

/** Tolerant single-row parser: bare row, or wrapped {location: …}/{data: …}. */
export function parseRowJson(j: unknown): LocationRow | null {
  if (j == null || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  for (const key of ["location", "data", "results"]) {
    if (o[key] != null && typeof o[key] === "object")
      return parseRowJson(o[key]);
  }
  return o as LocationRow;
}

export class PizzabaseApi implements RegistryProvider, LocationProvider {
  private cache = new Map<
    string,
    { at: number; rows: LocationRow[] }
  >();

  constructor(
    private baseUrl: string,
    private key: string,
  ) {}

  private async get(path: string): Promise<unknown | null> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.key) headers.authorization = `Basic ${this.key}`;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }

  /** Exact registry link for a registered govt source URL. */
  async findBySourceUrl(url: string): Promise<RegisteredSource | null> {
    if (!url) return null;
    const j = await this.get(
      `/wait-time-sources?url=${encodeURIComponent(url)}`,
    );
    const row = parseRowsJson(j).find(
      (s) => (s as { location_id?: unknown }).location_id != null,
    ) as { location_id?: number | string } | undefined;
    return row?.location_id != null
      ? { location_id: row.location_id, url }
      : null;
  }

  async getLocation(id: number | string): Promise<LocationRow | null> {
    const j = await this.get(`/locations/${encodeURIComponent(String(id))}`);
    return parseRowJson(j);
  }

  /** County/state-scoped `locations` lookup, process-cached (15 min TTL). */
  async listLocations(
    scope: LocationScope,
    limit: number,
  ): Promise<LocationRow[]> {
    const key = `${scope.state ?? ""}|${scope.county ?? ""}|${limit}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const params = new URLSearchParams({ limit: String(limit) });
    if (scope.state) params.set("state", scope.state);
    if (scope.county) params.set("county", scope.county);
    const j = await this.get(`/locations?${params.toString()}`);
    const rows = parseRowsJson(j);
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }
}
