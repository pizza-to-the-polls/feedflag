import { settings } from "../config.js";
import { normalizeWaitText } from "../normalize/wait-time.js";
import { mapLimit } from "../util.js";
import type { Observation } from "../types.js";

/**
 * Crowd leg: consume site-submitted reports from the pizzabase API.
 *
 * Reports are the GROUND TRUTH producer: structured at capture time
 * (validated address -> geocoded Location) and volunteer-reviewed, so —
 * unlike the social leg — they skip vision captioning and Jev classify.
 * They're emitted as high-confidence direct observations with location
 * attached, and the aggregator uses them to corroborate social/govt
 * extractions (see README "Producer / consumer").
 *
 * PII note: never emit contactInfo/contact names here — reportURL + Location
 * fields only.
 */

interface ReportJson {
  id: number | string;
  createdAt?: string;
  reportURL?: string;
  waitTime?: string | null;
  location?: {
    id?: number | string;
    name?: string;
    city?: string;
    state?: string;
    zip?: string;
    address?: string;
    fullAddress?: string;
    lat?: number;
    lng?: number;
  } | null;
}

async function fetchReportsPage(page: number, limit: number): Promise<ReportJson[]> {
  const url = `${settings.pizzabaseUrl}/reports?limit=${limit}&page=${page}`;
  const headers: Record<string, string> = { accept: "application/json" };
  // pizzabase checkAuthorization strips a "Basic " prefix (src/controller/helper.ts)
  if (settings.pizzabaseKey) headers.authorization = `Basic ${settings.pizzabaseKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`pizzabase /reports ${res.status} (wire a service token in pizzabase for machine auth)`);
  const j: unknown = await res.json();
  const arr = Array.isArray(j) ? j : ((j as { reports?: unknown[] }).reports ?? []);
  return arr as ReportJson[];
}

/** Page back from newest until we cross `since` (client-side filter — the API
 *  filters by truck/order/location, not date). */
export async function fetchSiteReportsSince(sinceIso: string, max: number): Promise<ReportJson[]> {
  const since = new Date(sinceIso).getTime();
  const out: ReportJson[] = [];
  const pageSize = 100;
  for (let page = 0; page < 10; page++) {
    const batch = await fetchReportsPage(page, pageSize);
    if (batch.length === 0) break;
    const fresh = batch.filter((r) => new Date(r.createdAt ?? 0).getTime() > since);
    out.push(...fresh);
    const oldest = new Date(batch[batch.length - 1]?.createdAt ?? 0).getTime();
    if (fresh.length < batch.length || oldest <= since || out.length >= max) break;
  }
  return out.slice(0, max);
}

export async function reportsToObservations(
  reports: ReportJson[],
  concurrency = 3,
): Promise<Observation[]> {
  return mapLimit(reports, concurrency, async (r) => {
    const loc = r.location ?? {};
    const norm = r.waitTime ? await normalizeWaitText(r.waitTime) : {};
    return {
      schema: "feedflag/observation@1",
      domain: "crowd",
      source_ref: `pizzabase:reports/${r.id}`,
      url: r.reportURL,
      platform: "site",
      observed_at: r.createdAt ?? new Date().toISOString(),
      posted_at: r.createdAt,
      location: {
        raw: loc.fullAddress ?? loc.address,
        state: loc.state,
        county: loc.city, // nearest we have w/o county on Location (see wait-time plan §1)
        precinct: loc.name,
      },
      signal_kind: "user_report",
      wait_minutes: norm.wait_minutes,
      wait_category: norm.wait_category,
      // direct, human-entered observation — no classifier in the loop
      confidence: 0.95,
      provider: "user-report",
      relevant: true,
      description: {
        item: {
          id: String(r.id),
          platform: "site",
          authorHandle: "site-reporter",
          postedAt: r.createdAt ?? new Date().toISOString(),
          caption: `User report: waitTime="${r.waitTime ?? ""}"`,
          hashtags: [],
          mediaUrls: [],
          url: r.reportURL,
          source: "pizzabase:reports",
        },
        caption: `User-submitted report. Wait time (free text): ${r.waitTime ?? "(none)"}`,
        imageDescriptions: [],
      },
    } satisfies Observation;
  });
}