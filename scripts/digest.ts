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

const FLAG_CONFIDENCE = Number(process.env.FLAG_CONFIDENCE ?? 0.7);

const HOURS = Number(
  (() => {
    const i = process.argv.indexOf("--hours");
    return i === -1 ? "24" : process.argv[i + 1];
  })(),
);
const SLACK = process.argv.includes("--slack");
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
    o.domain !== "crowd" &&
    !wrongLabels.has(observationId({ source_ref: o.source_ref, observed_at: o.observed_at, domain: o.domain })),
);
const mediaOf = (o: Obs): string | undefined => {
  const urls = o.description?.item?.mediaUrls ?? [];
  return urls.find((u) => /\.(jpe?g|png|webp)([?#]|$)/i.test(u)) ?? urls[0] ?? undefined;
};
const byDomain = new Map<string, number>();
const byKind = new Map<string, number>();
for (const o of obs) {
  byDomain.set(o.domain, (byDomain.get(o.domain) ?? 0) + 1);
  byKind.set(o.signal_kind, (byKind.get(o.signal_kind) ?? 0) + 1);
}

if (SLACK) {
  const parts: string[] = [];
  parts.push(
    ":pizza: *Feedflag digest — last " + HOURS + "h*",
  );
  parts.push(
    obs.length + " observations (" + [...byDomain.entries()].map(([d, n]) => n + " " + d).join(", ") + ") · *" + flagged.length + " flagged* ≥70%",
  );
  for (const f of flagged) {
    const id8 = observationId({ source_ref: f.source_ref, observed_at: f.observed_at, domain: f.domain });
    parts.push(
      "• [" + id8 + "] " +
        pct(f.confidence) +
        " " +
        (KIND_EMOJI[f.signal_kind] ?? "") +
        f.signal_kind +
        " @" +
        (f.author ?? "?") +
        (f.url ? " — " + f.url : ""),
    );
  }
  parts.push(
    "Feedback: `npm run label -- --add <ID>=right|wrong[:category]` — or tell Pi in chat which [ID]s were wrong",
  );
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
      icon_url: "https://github.com/pizza-to-the-polls.png",
      attachments: images.length
        ? images.map((image) => ({ color: "#E01B5D", fallback: "flagged media", image_url: image }))
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
    const id8 = observationId({ source_ref: f.source_ref, observed_at: f.observed_at, domain: f.domain });
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
const sampleCaption = sample?.description?.caption || obs.find((o) => o.description?.caption)?.description?.caption;
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