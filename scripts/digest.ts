#!/usr/bin/env node
/**
 * Daily findings digest — summarizes recent observations + flags to markdown.
 * Used by the scheduled workflow: posts as a comment on the pinned Findings
 * issue so there's always something human-readable to check in the morning.
 *
 *   npm run digest -- --hours 24
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { observationId } from "../src/util.js";
import { loadFeedsConfig } from "../src/config.js";

// Flag-worthy categories mirror the pipeline's flagCategories policy —
// the digest table shows what the flag feed would show (line-related only;
// press/community noise labels away from Slack and stays in the bus).
const FLAG_CATEGORIES = loadFeedsConfig().flagCategories ?? undefined;

const FLAG_CONFIDENCE = Number(process.env.FLAG_CONFIDENCE ?? 0.7);

const HOURS = Number(
  (() => {
    const i = process.argv.indexOf("--hours");
    return i === -1 ? "24" : process.argv[i + 1];
  })(),
);
const SLACK = process.argv.includes("--slack");
const DATA_DIR = process.env.DATA_DIR ?? "./data";
// Where the digest reads from. "file" is the original local mode (the
// operator CLI); "db" is what the bastion timer uses (issue #69): the
// system of record via GET {PIZZABASE_API_URL}/feed-observations/summary.
// data/observations.jsonl is NOT a 26h window any more — the runner gzips
// it to /opt/feedflag-archive/ and empties it after every successful emit —
// so a "last 26h" digest built from the file reports one leg's batch.
const SOURCE = (() => {
  const i = process.argv.indexOf("--source");
  if (i !== -1) return process.argv[i + 1] === "db" ? "db" : "file";
  // Unflagged: db when credentials are present (the timer always has them),
  // file otherwise (the operator CLI on a laptop without keys).
  return process.env.PIZZABASE_API_URL && process.env.PIZZABASE_API_KEY
    ? "db"
    : "file";
})();
// Issue #69's loud floor: below this the digest REFUSES to post (exit 1 →
// the runner's maybe_alert) instead of publishing a plausible-looking digest
// of a broken pipeline. Default 1: a window with ZERO observations is never
// worth posting silently — that is the total-outage signature, so it must
// alert, not print "No observations" and exit 0.
const MIN_OBSERVATIONS = Number(process.env.DIGEST_MIN_OBSERVATIONS ?? 1);

interface Obs {
  schema: string;
  domain: string;
  source_ref?: string;
  url?: string;
  author?: string;
  platform?: string;
  observed_at: string;
  signal_kind: string;
  confidence: number;
  provider: string;
  relevant: boolean;
  wait_minutes?: number | null;
  location?: { raw?: string; city?: string; county?: string; state?: string };
  description?: {
    caption?: string;
    item?: { mediaUrls?: string[]; videoUrl?: string };
  };
}

function load(): Obs[] {
  const p = join(DATA_DIR, "observations.jsonl");
  if (!existsSync(p)) return [];
  const since = Date.now() - HOURS * 3600 * 1000;
  const seen = new Set<string>();
  const out: Obs[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Obs;
      if (!o.observed_at || new Date(o.observed_at).getTime() < since) continue;
      const key = `${o.domain}:${o.source_ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const KIND_EMOJI: Record<string, string> = {
  poll_line_report: "🗳️",
  food_delivery_moment: "🍕",
  press_mention: "📰",
  community_shoutout: "📣",
  user_report: "👤",
  irrelevant: "·",
};

function loadLabels(): Set<string> {
  const p = join(DATA_DIR, "labels.jsonl");
  if (!existsSync(p)) return new Set();
  const out = new Set<string>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line) as { id: string; verdict: string };
      if (l.verdict === "wrong") out.add(l.id);
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ── db mode ────────────────────────────────────────────────────────────────────────
// Everything the summary endpoint returns, per pizzabase PR #359. Counts are
// DISTINCT (domain, source_ref) pairs — matching this script's file-mode
// dedupe — and flagged_recent carries identity-free fields only (PII floor:
// no caption, author, or description text), which is why db mode renders a
// link-out table instead of media embeds and sample captions.
interface SummaryResponse {
  since: string;
  total_observations: number;
  govt_rows: number;
  social_rows: number;
  crowd_rows: number;
  flagged_count: number;
  hot_govt_count: number;
  govt_source_count: number;
  crowd_relevant_count: number;
  by_signal_kind: { kind: string; count: number }[];
  flagged_recent: {
    source_ref: string;
    signal_kind: string;
    confidence: number;
    url: string | null;
    platform: string | null;
    observed_at: string;
  }[];
}

async function fetchSummary(): Promise<SummaryResponse> {
  const API = (process.env.PIZZABASE_API_URL ?? "").replace(/\/+$/, "");
  const TOKEN = process.env.PIZZABASE_API_KEY ?? "";
  if (!API || !TOKEN) {
    console.error(
      "[digest] --source db requires PIZZABASE_API_URL + PIZZABASE_API_KEY",
    );
    process.exit(1);
  }
  const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const q = new URLSearchParams({
    since,
    min_confidence: String(FLAG_CONFIDENCE),
    // Absent flagCategories means every category is flag-worthy; the API's
    // explicitly-empty string carries that same meaning.
    flag_categories: FLAG_CATEGORIES ? FLAG_CATEGORIES.join(",") : "",
  });
  const res = await fetch(`${API}/feed-observations/summary?${q.toString()}`, {
    headers: { authorization: `Basic ${TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.error(
      `[digest] summary endpoint ${res.status} — pizzabase unreachable or unauthorized`,
    );
    process.exit(1);
  }
  return (await res.json()) as SummaryResponse;
}

function renderDbDigest(
  s: SummaryResponse,
  flagged: SummaryResponse["flagged_recent"],
): string {
  const byDomain: [string, number][] = [
    ["govt", s.govt_rows],
    ["social", s.social_rows],
    ["crowd", s.crowd_rows],
  ].filter(([, n]) => n > 0) as [string, number][];
  const kindList = [...s.by_signal_kind]
    .sort((a, b) => b.count - a.count)
    .map((k) => `${k.count} ${KIND_EMOJI[k.kind] ?? ""}${k.kind}`.trim())
    .join(" · ");

  if (SLACK) {
    const parts: string[] = [];
    parts.push(":pizza: *Feedflag digest — last " + HOURS + "h*");
    parts.push(
      `${s.total_observations} observations (${byDomain.map(([d, n]) => `${n} ${d}`).join(", ")})`,
    );
    if (kindList) parts.push(kindList);
    parts.push(
      `:stopwatch: ${s.govt_source_count} gov sources — ${s.hot_govt_count} ≥60min hot now`,
    );
    if (flagged.length) {
      parts.push(
        ":triangular_flag_on_post: " + flagged.length + " social flag(s):",
      );
      for (const f of flagged) {
        parts.push(
          "  • " +
            pct(f.confidence) +
            " " +
            (KIND_EMOJI[f.signal_kind] ?? "") +
            f.signal_kind +
            (f.url ? " — " + f.url : ""),
        );
      }
    }
    return (
      JSON.stringify({
        text: parts.join("\n"),
        username: "feedflag",
        icon_emoji: ":feedflag:",
      }) + "\n"
    );
  }

  const lines: string[] = [];
  lines.push(`## Feedflag digest — last ${HOURS}h`);
  lines.push("");
  lines.push(
    `**${s.total_observations} observations** (${byDomain.map(([d, n]) => `${n} ${d}`).join(", ")}) · **${flagged.length} flagged** ≥${pct(FLAG_CONFIDENCE)} confidence`,
  );
  if (s.flagged_count > flagged.length) {
    lines.push(
      `*(+${s.flagged_count - flagged.length} older or wrong-verdict flags outside this table)*`,
    );
  }
  lines.push("");
  if (kindList) lines.push(`**By signal kind:** ${kindList}`);
  lines.push("");
  lines.push(
    `:stopwatch: **${s.govt_source_count}** gov sources tracked — **${s.hot_govt_count} ≥60min hot now** · **${s.crowd_relevant_count}** crowd ground-truth reports`,
  );
  if (flagged.length > 0) {
    lines.push("");
    lines.push("### 🚩 Flagged");
    lines.push("");
    lines.push("| ID | Platform | Kind | Conf | Link |");
    lines.push("|---|---|---|---|---|");
    for (const f of flagged) {
      const id8 = observationId({
        source_ref: f.source_ref,
        observed_at: f.observed_at,
        domain: "social",
      });
      lines.push(
        `| ${id8} | ${f.platform ?? "?"} | ${KIND_EMOJI[f.signal_kind] ?? ""}${f.signal_kind} | ${pct(f.confidence)} | ${f.url ? `[view](${f.url})` : "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "*Media and captions are omitted in db mode: the summary endpoint is PII-free by design (no author, caption, or description text), so the flagged table links out instead.*",
  );
  lines.push("");
  lines.push(
    `*Window: ${HOURS}h · source: pizzabase feed_observations (system of record) · classifier: jev via OpenRouter*`,
  );
  return lines.join("\n");
}

if (SOURCE === "db") {
  const s = await fetchSummary();
  if (s.total_observations < MIN_OBSERVATIONS) {
    console.error(
      `[digest] ${s.total_observations} observations in the last ${HOURS}h is below the floor (${MIN_OBSERVATIONS}) — ` +
        `the pipeline or emit-to-DB leg may be broken. REFUSING to post a digest that looks plausible over a dead pipeline. ` +
        `Set DIGEST_MIN_OBSERVATIONS to adjust.`,
    );
    process.exit(1);
  }
  const wrongLabels = loadLabels();
  const flagged = s.flagged_recent.filter(
    (f) =>
      !wrongLabels.has(
        observationId({
          source_ref: f.source_ref,
          observed_at: f.observed_at,
          domain: "social",
        }),
      ),
  );
  process.stdout.write(renderDbDigest(s, flagged));
  process.exit(0);
}

const obs = load();
if (obs.length === 0) {
  console.log(
    SLACK
      ? `:pizza: *Feedflag digest — last ${HOURS}h* — no observations in the window (pipeline may not have run).`
      : `## Feedflag digest — last ${HOURS}h\n\nNo observations in the window. (Pipeline may not have run — check Actions tab.)`,
  );
  process.exit(0);
}

// Classifier picks only — crowd rows are ground truth (fixed 0.95, no
// classifier in the loop) and never appear in the notifier's flags.
// Wrong-labeled flags (feedback) are excluded — user saw them once, verdict'd
// them wrong, shouldn't see them again.
const wrongLabels = loadLabels();
const flagged = obs.filter(
  (o) =>
    o.relevant &&
    o.confidence >= FLAG_CONFIDENCE &&
    o.domain === "social" &&
    (!FLAG_CATEGORIES || FLAG_CATEGORIES.includes(o.signal_kind)) &&
    !wrongLabels.has(
      observationId({
        source_ref: o.source_ref,
        observed_at: o.observed_at,
        domain: o.domain,
      }),
    ),
);
const mediaOf = (o: Obs): string | undefined => {
  const urls = o.description?.item?.mediaUrls ?? [];
  return (
    urls.find((u) => /\.(jpe?g|png|webp)([?#]|$)/i.test(u)) ??
    urls[0] ??
    undefined
  );
};
const byDomain = new Map<string, number>();
const byKind = new Map<string, number>();
for (const o of obs) {
  byDomain.set(o.domain, (byDomain.get(o.domain) ?? 0) + 1);
  byKind.set(o.signal_kind, (byKind.get(o.signal_kind) ?? 0) + 1);
}

if (SLACK) {
  const parts: string[] = [];
  parts.push(":pizza: *Feedflag digest — last " + HOURS + "h*");
  parts.push(
    obs.length +
      " observations (" +
      [...byDomain.entries()].map(([d, n]) => n + " " + d).join(", ") +
      ")",
  );
  // govt: compact per-source line — sites tracked, any >= 60min lines hot now
  const govt = obs.filter((o) => o.domain === "govt");
  if (govt.length) {
    const hot = govt.filter((o) => (o.wait_minutes ?? 0) >= 60);
    const counties = [
      ...new Set(
        govt.map((o) => `${o.author ?? ""}`.replace(/ ?Wait Time.*/i, "")),
      ),
    ];
    parts.push(
      ":stopwatch: " +
        govt.length +
        " gov readings (" +
        counties.slice(0, 6).join(" · ") +
        (counties.length > 6 ? " +" + (counties.length - 6) : "") +
        ")" +
        (hot.length ? " — *" + hot.length + " ≥60min now:" : " — none ≥60min"),
    );
    for (const h of hot.slice(0, 6)) {
      parts.push(
        "  • " +
          (h.location?.raw ?? "(unnamed)").slice(0, 40) +
          ": " +
          h.wait_minutes +
          " min" +
          (h.location?.county || h.location?.state
            ? ` (${[h.location.city, h.location.county, h.location.state].filter(Boolean).join(", ")})`
            : ""),
      );
    }
  }
  if (flagged.length) {
    parts.push(
      ":triangular_flag_on_post: " + flagged.length + " social flag(s):",
    );
    for (const f of flagged) {
      parts.push(
        "  • " +
          pct(f.confidence) +
          " " +
          (KIND_EMOJI[f.signal_kind] ?? "") +
          f.signal_kind +
          " @" +
          (f.author ?? "?") +
          " — " +
          f.url,
      );
    }
  }
  // JSON payload (not bare text): embeds up to 4 flagged thumbnails via
  // attachments.image_url. Workflow posts this with --data-binary @file.
  const images = flagged
    .map((f) => mediaOf(f))
    .filter((u): u is string => !!u)
    .slice(0, 4);
  console.log(
    JSON.stringify({
      text: parts.join("\n"),
      username: "feedflag",
      icon_emoji: ":feedflag:",
      attachments: images.length
        ? images.map((image) => ({
            color: "#E01B5D",
            fallback: "flagged media",
            image_url: image,
          }))
        : undefined,
    }),
  );
  process.exit(0);
}

const lines: string[] = [];
lines.push(`## Feedflag digest — last ${HOURS}h`);
lines.push("");
lines.push(
  `**${obs.length} observations** (${[...byDomain.entries()].map(([d, n]) => `${n} ${d}`).join(", ")}) · **${flagged.length} flagged** ≥70% confidence`,
);
lines.push("");
const kindList = [...byKind.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${n} ${KIND_EMOJI[k] ?? ""}${k}`.trim())
  .join(" · ");
lines.push(`**By signal kind:** ${kindList}`);

if (flagged.length > 0) {
  lines.push("");
  lines.push("### 🚩 Flagged");
  lines.push("");
  lines.push("| ID | Platform | Who | Kind | Conf | Provider | Link |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const f of flagged) {
    const id8 = observationId({
      source_ref: f.source_ref,
      observed_at: f.observed_at,
      domain: f.domain,
    });
    const link = f.url ? `[view](${f.url})` : "—";
    lines.push(
      `| ${id8} | ${f.platform ?? "?"} | @${f.author ?? "?"} | ${KIND_EMOJI[f.signal_kind] ?? ""}${f.signal_kind} | ${pct(f.confidence)} | ${f.provider} | ${link} |`,
    );
  }
  lines.push("");
  lines.push("### Flagged media");
  lines.push("");
  lines.push(
    "*Hotlinked from platform CDNs (signed URLs expire — Slack is the durable surface).*",
  );
  for (const f of flagged.slice(0, 4)) {
    const img = mediaOf(f);
    if (img) {
      lines.push("");
      lines.push(`**${f.signal_kind} — @${f.author ?? "?"}**`);
      lines.push("");
      lines.push(`![${f.signal_kind}](${img})`);
    }
  }
}

const sample = obs.find((o) => o.relevant && o.description?.caption);
const sampleCaption =
  sample?.description?.caption ||
  obs.find((o) => o.description?.caption)?.description?.caption;
if (sampleCaption) {
  lines.push("");
  lines.push("### Sample caption (from the description sets)");
  lines.push("");
  lines.push(`> ${String(sampleCaption).slice(0, 280).replace(/\n/g, " ")}`);
}

lines.push("");
lines.push(
  `*Window: ${HOURS}h · sources: Apify (IG/TikTok) + pizzabase /reports · classifier: jev via OpenRouter*`,
);
console.log(lines.join("\n"));
