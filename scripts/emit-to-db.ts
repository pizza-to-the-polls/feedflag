/**
 * Emit observations to the pizzabase feed_observations table over the
 * machine-token-authed bulk endpoint (FEAT-002d; pizzabase #294/#306).
 *
 *   npx tsx scripts/emit-to-db.ts [--hours 24] [--dry]
 *
 * Reads data/observations.jsonl, filters to the window (default 24h),
 * batches (≤50), POSTs {"observations":[...]} — snake_case per the API —
 * and prints {inserted, skipped}. Idempotent: re-runs skip existing rows
 * (server-side ON CONFLICT DO NOTHING on source_ref+observed_at).
 *
 * Failure is non-fatal to the pipeline (JSONL stays the local audit copy);
 * this script exits 0 with a warning so CI runs stay green.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const API = (process.env.PIZZABASE_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.PIZZABASE_API_KEY ?? "";
const DRY = process.argv.includes("--dry");

const HOURS = Number(
  (() => {
    const i = process.argv.indexOf("--hours");
    return i === -1 ? "24" : process.argv[i + 1];
  })(),
);

interface Obs {
  schema: string;
  domain: string;
  source_ref?: string;
  url?: string;
  author?: string;
  platform?: string;
  observed_at: string;
  posted_at?: string;
  location?: unknown;
  signal_kind: string;
  wait_minutes?: number | null;
  wait_category?: string | null;
  confidence: number;
  provider?: string;
  relevant?: boolean;
  description?: unknown;
}

/** epoch-ms (Clark/Ramsey Last_Refresh) or ISO string → ISO string; else null */
function toIsoTimestamp(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(s)) return d.toISOString();
  // pure epoch string ("1792642500000")
  if (/^\d{12,14}$/.test(s)) {
    const d2 = new Date(Number(s));
    return Number.isNaN(d2.getTime()) ? null : d2.toISOString();
  }
  return null;
}

/** snake_case API payload per pizzabase FeedObservationsController.create */
function toApi(o: Obs): Record<string, unknown> {
  return {
    domain: o.domain,
    source_ref: o.source_ref ?? "(unknown)",
    url: o.url ?? null,
    author: o.author ?? null,
    platform: o.platform ?? null,
    observed_at: toIsoTimestamp(o.observed_at) ?? new Date().toISOString(),
    posted_at: toIsoTimestamp(o.posted_at),
    location: o.location ?? null,
    signal_kind: o.signal_kind,
    wait_minutes: o.wait_minutes ?? null,
    wait_category: o.wait_category ?? null,
    confidence: o.confidence,
    provider: o.provider ?? null,
    relevant: o.relevant ?? null,
    description: o.description ?? {},
  };
}

async function post(observations: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number } | null> {
  if (!API || !TOKEN) {
    console.log("[emit] PIZZABASE_API_URL / PIZZABASE_API_KEY unset — skipping (non-fatal)");
    return null;
  }
  try {
    const res = await fetch(`${API}/feed-observations`, {
      method: "POST",
      headers: {
        authorization: `Basic ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ observations }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[emit] POST ${res.status}: ${(await res.text()).slice(0, 150)}`);
      return null;
    }
    const j = (await res.json()) as { inserted?: number; skipped?: number; errors?: string[] };
    if (j.errors?.length) console.warn(`[emit] API errors: ${j.errors.slice(0, 2).join("; ")}`);
    return { inserted: j.inserted ?? 0, skipped: j.skipped ?? 0 };
  } catch (err) {
    console.warn(`[emit] POST failed: ${String(err).slice(0, 120)}`);
    return null;
  }
}

const main = async () => {
  const path = join(DATA_DIR, "observations.jsonl");
  if (!existsSync(path)) {
    console.log("[emit] no observations.jsonl — nothing to do");
    return;
  }
  const since = Date.now() - HOURS * 3600 * 1000;
  const seen = new Set<string>();
  const batch: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Obs;
      if (!o.observed_at || new Date(o.observed_at).getTime() < since) continue;
      const key = `${o.domain}:${o.source_ref}:${o.observed_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push(toApi(o));
    } catch {
      // skip malformed
    }
  }
  if (!batch.length) {
    console.log(`[emit] 0 observations in the last ${HOURS}h`);
    return;
  }
  if (DRY) {
    console.log(`[emit] dry: would POST ${batch.length} observation(s)`);
    return;
  }
  let inserted = 0;
  let skipped = 0;
  let sent = 0;
  for (let i = 0; i < batch.length; i += 50) {
    const chunk = batch.slice(i, i + 50);
    const r = await post(chunk);
    if (r) {
      inserted += r.inserted;
      skipped += r.skipped;
      sent += chunk.length;
    }
  }
  console.log(`[emit] ${sent}/${batch.length} sent → inserted ${inserted}, skipped ${skipped}`);
};

main().catch((err) => {
  console.error(`[emit] FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});