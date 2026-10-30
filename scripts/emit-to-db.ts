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
 * A 413 (body too large) is bisected and retried at half size — a fixed
 * 50-row chunk blows the API body limit whenever the row mix carries fat
 * description blobs (observed 2026-10-28: run-dependent 413s dropped the
 * NEW observations and tripped the TOTAL-FAILURE exit).
 *
 * Failure is non-fatal to the pipeline (JSONL stays the local audit copy);
 * this script exits 0 with a warning so CI runs stay green.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasGovtEvidence } from "../src/govt/evidence.js";

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
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(s))
    return d.toISOString();
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

type PostResult =
  | { ok: true; inserted: number; skipped: number }
  | { ok: false; status: number }; // 0 = network/timeout

async function post(
  observations: Record<string, unknown>[],
): Promise<PostResult> {
  if (!API || !TOKEN) {
    console.log(
      "[emit] PIZZABASE_API_URL / PIZZABASE_API_KEY unset — skipping (non-fatal)",
    );
    return { ok: false, status: 0 };
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
      console.warn(
        `[emit] POST ${res.status}: ${(await res.text()).slice(0, 150)}`,
      );
      return { ok: false, status: res.status };
    }
    const j = (await res.json()) as {
      inserted?: number;
      skipped?: number;
      errors?: string[];
    };
    if (j.errors?.length)
      console.warn(`[emit] API errors: ${j.errors.slice(0, 2).join("; ")}`);
    return { ok: true, inserted: j.inserted ?? 0, skipped: j.skipped ?? 0 };
  } catch (err) {
    console.warn(`[emit] POST failed: ${String(err).slice(0, 120)}`);
    return { ok: false, status: 0 };
  }
}

interface SendTotals {
  sent: number;
  inserted: number;
  skipped: number;
}

/** POST a chunk, bisecting on 413 (payload too large) until rows fit.
 *  Other failures mark the whole chunk unsent (as before). A single row
 *  that still 413s is skipped loudly — it never sinks the rest of the
 *  batch or the TOTAL-FAILURE exit heuristic. */
async function sendChunk(rows: Record<string, unknown>[]): Promise<SendTotals> {
  if (!rows.length) return { sent: 0, inserted: 0, skipped: 0 };
  const r = await post(rows);
  if (r.ok)
    return { sent: rows.length, inserted: r.inserted, skipped: r.skipped };
  if (r.status === 413 && rows.length > 1) {
    const mid = rows.length >> 1;
    const a = await sendChunk(rows.slice(0, mid));
    const b = await sendChunk(rows.slice(mid));
    return {
      sent: a.sent + b.sent,
      inserted: a.inserted + b.inserted,
      skipped: a.skipped + b.skipped,
    };
  }
  if (r.status === 413)
    console.warn(
      `[emit] 413 even for a single observation — skipping it: ${String(rows[0]?.source_ref ?? "(unknown)").slice(0, 100)}`,
    );
  return { sent: 0, inserted: 0, skipped: 0 };
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
  let evidenceBlocked = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Obs;
      if (!o.observed_at || new Date(o.observed_at).getTime() < since) continue;
      const key = `${o.domain}:${o.source_ref}:${o.observed_at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Belt-and-braces (issue #20): govt observations must carry a raw-REST
      // evidence block. Gated writers always attach one; `description: {}` is
      // the pre-gate-code signature that re-posted frozen Clark NV waits at
      // 95% confidence on 2026-10-28 — refuse it at the DB door too.
      if (o.domain === "govt" && !hasGovtEvidence(o.description)) {
        evidenceBlocked++;
        console.warn(
          `[emit] skipping govt observation ${o.source_ref ?? "(unknown)"}: no evidence block (pre-gate code signature, issue #20)`,
        );
        continue;
      }
      batch.push(toApi(o));
    } catch {
      // skip malformed
    }
  }
  if (!batch.length) {
    console.log(
      `[emit] 0 observations in the last ${HOURS}h` +
        (evidenceBlocked > 0
          ? ` (${evidenceBlocked} evidence-blocked, issue #20)`
          : ""),
    );
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
    const r = await sendChunk(batch.slice(i, i + 50));
    inserted += r.inserted;
    skipped += r.skipped;
    sent += r.sent;
  }
  console.log(
    `[emit] ${sent}/${batch.length} sent → inserted ${inserted}, skipped ${skipped}` +
      (evidenceBlocked > 0
        ? `, evidence-blocked ${evidenceBlocked} (issue #20)`
        : ""),
  );
  // TOTAL FAILURE = everything POSTed, nothing landed, AND nothing reported
  // as an existing duplicate (API errors, not idempotent skips). Hard-fail so
  // callers alert — the 4-day-silent-DB postmortem rule: never fail quiet.
  // inserted=0 + skipped>0 is the normal re-run case (every 15-min leg
  // re-POSTs the same 4h window; the server dedupes) — it must NOT alert
  // (observed 2026-10-30 03:15: social leg TOTAL-FAILURE false alarm while
  // peak had inserted the same rows a minute earlier).
  if (sent > 0 && inserted === 0 && skipped === 0 && !DRY) {
    console.error(
      `[emit] TOTAL FAILURE — ${sent} sent, 0 inserted. Observations are NOT reaching feed_observations.`,
    );
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(`[emit] FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
