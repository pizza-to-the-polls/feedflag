#!/usr/bin/env node
/**
 * Feedback loop for the classifier — human labels on flagged observations.
 *
 *   npm run label -- --list [--hours 25]              review queue (unlabeled flags)
 *   npm run label -- --add a1b2c3d4=right              label one right
 *   npm run label -- --add a1b2c3d4=wrong              label wrong (category stands as-is)
 *   npm run label -- --add a1b2c3d4=wrong:press_mention label wrong + correct category
 *   npm run label -- --add id1=right,id2=wrong:foo     multiple
 *   npm run label -- --report                          precision + calibration + confusion
 *
 * Labels land in data/labels.jsonl (id → verdict, correct_category?, note?).
 * They do NOT retrain Jev — they tune FLAG_CONFIDENCE against measured precision,
 * measure Jev calibration (JEV_EXPLORATION §3 gate), feed few-shot examples to
 * the LLM fallback, and expose taxonomy problems (confused pairs → feeds.json).
 *
 * Give feedback however is easiest: run --add here, or just tell Pi in chat
 * ("the @whoever flag was wrong") and it applies labels with this script.
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { observationId } from "../src/util.js";

const DATA_DIR = process.env.DATA_DIR ?? "./data";

interface Obs {
  domain: string;
  source_ref?: string;
  observed_at: string;
  signal_kind: string;
  confidence: number;
  provider: string;
  relevant: boolean;
  author?: string;
  platform?: string;
  url?: string;
  description?: { item?: { mediaUrls?: string[] } };
}

interface Label {
  id: string;
  verdict: "right" | "wrong";
  correct_category?: string;
  note?: string;
  labeled_at: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function loadObservations(): Obs[] {
  const p = join(DATA_DIR, "observations.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Obs)
    .filter((o) => o.observed_at);
}

function loadLabels(): Label[] {
  const p = join(DATA_DIR, "labels.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Label);
}

function appendLabel(l: Label): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(join(DATA_DIR, "labels.jsonl"), JSON.stringify(l) + "\n");
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ---- modes ----

if (process.argv.includes("--add")) {
  const spec = arg("add") ?? "";
  const note = arg("note");
  let applied = 0;
  for (const part of spec.split(",").filter((s) => s.trim())) {
    const m = part
      .trim()
      .match(/^([0-9a-f]{8})=(right|wrong)(?::([a-z_]+))?$/i);
    if (!m) {
      console.error(
        `! unparsed label spec: "${part.trim()}" — use <8-char-id>=right|wrong[:category]`,
      );
      continue;
    }
    appendLabel({
      id: m[1]!.toLowerCase(),
      verdict: m[2] as "right" | "wrong",
      correct_category: m[3],
      note,
      labeled_at: new Date().toISOString(),
    });
    applied++;
    console.log(`✓ labeled ${m[1]} ${m[2]}${m[3] ? ` (→ ${m[3]})` : ""}`);
  }
  if (applied) {
    console.error(
      `\n${applied} label(s) recorded in ${join(DATA_DIR, "labels.jsonl")} — commit them as regular work.`,
    );
  }
  process.exit(applied ? 0 : 1);
}

const obs = loadObservations();
const labels = loadLabels();
const idOf = (o: Obs) =>
  observationId({
    source_ref: o.source_ref,
    observed_at: o.observed_at,
    domain: o.domain,
  });
const byId = new Map(obs.map((o) => [idOf(o), o]));
const labeledIds = new Set(labels.map((l) => l.id));

if (process.argv.includes("--report")) {
  const flagged = obs.filter(
    (o) =>
      o.relevant &&
      o.confidence >= FLAG_CONFIDENCE &&
      o.domain === "social" &&
      (!FLAG_CATEGORIES || FLAG_CATEGORIES.includes(o.signal_kind)),
  );
  const lab = labels
    .map((l) => ({ l, o: byId.get(l.id) }))
    .filter((x): x is { l: Label; o: Obs } => !!x.o);
  console.log(`## Classifier feedback report`);
  console.log(
    `\n**${labels.length} labels** on **${flagged.length} lifetime flags** (labeled-matchable: ${lab.length})\n`,
  );
  if (lab.length === 0) {
    console.log(
      "No matched labels yet. Run `npm run label -- --list` and label a few flags.",
    );
    process.exit(0);
  }
  // Precision at thresholds (on labeled, delivered flags)
  console.log(
    `**Precision @ FLAG_CONFIDENCE thresholds** (labeled flags only):\n`,
  );
  console.log(`| threshold | n labeled | precision |\n|---|---|---|`);
  let suggestion = "";
  for (const t of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    const rows = lab.filter(
      (x) => x.o.confidence >= t && x.o.relevant && x.o.domain !== "crowd",
    );
    const right = rows.filter((x) => x.l.verdict === "right").length;
    const p = rows.length ? right / rows.length : 0;
    if (rows.length) console.log(`| ${pct(t)} | ${rows.length} | ${pct(p)} |`);
    if (!suggestion && rows.length >= 3 && p >= 0.9)
      suggestion = `FLAG_CONFIDENCE=${t} reaches ${pct(p)} precision on ${rows.length} labels`;
  }
  if (!suggestion)
    suggestion =
      "insufficient labels at ≥90% precision yet — keep labeling (need ≥3 right per threshold)";
  // Calibration buckets (stated vs actual — JEV_EXPLORATION §3)
  console.log(
    `\n**Calibration** (stated confidence vs actual accuracy — Jev claims calibration):\n`,
  );
  console.log(`| stated conf bucket | n | actual accuracy |\n|---|---|---|`);
  for (const [lo, hi] of [
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 1.01],
  ]) {
    const rows = lab.filter(
      (x) =>
        x.o.confidence >= lo && x.o.confidence < hi && x.o.domain !== "crowd",
    );
    if (!rows.length) continue;
    const right = rows.filter((x) => x.l.verdict === "right").length;
    console.log(
      `| ${pct(lo)}–${pct(hi)} | ${rows.length} | ${pct(right / rows.length)} |`,
    );
  }
  // Confusion pairs
  const wrongs = lab.filter((x) => x.l.verdict === "wrong");
  if (wrongs.length) {
    console.log(`\n**Confusion pairs** (picked → should have been):\n`);
    for (const x of wrongs) {
      console.log(
        `- ${x.o.signal_kind} → ${x.l.correct_category ?? "(unspecified)"} — @${x.o.author ?? "?"} ${x.o.url ?? ""}`,
      );
    }
  }
  console.log(`\n**Suggestion:** ${suggestion}`);
  process.exit(0);
}

// ---- default: review queue ----
const hours = Number(arg("hours") ?? 25);
const since = Date.now() - hours * 3600 * 1000;
const queue = obs
  .filter(
    (o) =>
      o.relevant &&
      o.confidence >= FLAG_CONFIDENCE &&
      o.domain === "social" &&
      (!FLAG_CATEGORIES || FLAG_CATEGORIES.includes(o.signal_kind)),
  )
  .filter((o) => new Date(o.observed_at).getTime() >= since)
  .filter((o) => !labeledIds.has(idOf(o)))
  .sort((a, b) => b.observed_at.localeCompare(a.observed_at));

console.log(
  `## Review queue — ${queue.length} unlabeled flags (last ${hours}h)\n`,
);
if (!queue.length)
  console.log(
    `Nothing to label. (All flags labeled, or no flags in window.)\n`,
  );
for (const o of queue) {
  const media = o.description?.item?.mediaUrls?.[0];
  console.log(
    `[${idOf(o)}] ${pct(o.confidence)} ${o.signal_kind} @${o.author ?? "?"} (${o.platform ?? "?"}, ${o.provider})\n    ${o.url ?? "(no url)"}${media ? `\n    media: ${media}` : ""}\n`,
  );
}
console.log(`Label with: npm run label -- --add <ID>=right|wrong[:category]`);
