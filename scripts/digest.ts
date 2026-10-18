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

const HOURS = Number(
  (() => {
    const i = process.argv.indexOf("--hours");
    return i === -1 ? "24" : process.argv[i + 1];
  })(),
);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

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
  description?: { caption?: string };
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

const obs = load();
if (obs.length === 0) {
  console.log(`## Feedflag digest — last ${HOURS}h\n\nNo observations in the window. (Pipeline may not have run — check Actions tab.)`);
  process.exit(0);
}

const flagged = obs.filter((o) => o.relevant && o.confidence >= 0.7);
const byDomain = new Map<string, number>();
const byKind = new Map<string, number>();
for (const o of obs) {
  byDomain.set(o.domain, (byDomain.get(o.domain) ?? 0) + 1);
  byKind.set(o.signal_kind, (byKind.get(o.signal_kind) ?? 0) + 1);
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
  lines.push("| Platform | Who | Kind | Conf | Provider | Link |");
  lines.push("|---|---|---|---|---|---|");
  for (const f of flagged) {
    const link = f.url ? `[view](${f.url})` : "—";
    lines.push(
      `| ${f.platform ?? "?"} | @${f.author ?? "?"} | ${KIND_EMOJI[f.signal_kind] ?? ""}${f.signal_kind} | ${pct(f.confidence)} | ${f.provider} | ${link} |`,
    );
  }
}

const sample = obs.find((o) => o.relevant && o.description?.caption);
if (sample?.description?.caption) {
  lines.push("");
  lines.push("### Sample caption (from the description sets)");
  lines.push("");
  lines.push(`> ${sample.description.caption.slice(0, 280).replace(/\n/g, " ")}`);
}

lines.push("");
lines.push(
  `*Window: ${HOURS}h · sources: Apify (IG/TikTok) + pizzabase /reports · classifier: jev via OpenRouter*`,
);
console.log(lines.join("\n"));