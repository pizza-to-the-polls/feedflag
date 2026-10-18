import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Platform } from "./types.js";

export interface FeedSource {
  platform: Platform;
  adapter: "rsshub" | "apify";
  /** rsshub: the handle; used for the route */
  handle?: string;
  /** apify: actor id, e.g. "apify/instagram-scraper" */
  actor?: string;
  /** apify: actor input payload */
  input?: Record<string, unknown>;
  /** max items per fetch */
  limit?: number;
}

export interface FeedsConfig {
  sources: FeedSource[];
  /** Enum categories JEV chooses from. Max 255 (Jev choice cardinality limit). */
  categories: string[];
  /** Categories that raise a Slack flag. Defaults to all categories.
  *  Label feedback (2026-10-18): press/community/delivery categories are
  *  archive-only — the dispatch signal is LINES. */
  flagCategories?: string[];
}

const env = process.env;

export function loadFeedsConfig(): FeedsConfig {
  const path = resolve(env.FEEDS_CONFIG ?? "./config/feeds.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as FeedsConfig;
  if (!cfg.sources?.length) throw new Error(`No sources in ${path}`);
  if (!cfg.categories?.length) throw new Error(`No categories in ${path}`);
  if (cfg.categories.length > 255) {
    throw new Error(`categories.length=${cfg.categories.length} > 255 (Jev decision cardinality limit)`);
  }
  if (cfg.flagCategories && !cfg.flagCategories.every((c) => cfg.categories.includes(c))) {
    throw new Error(`flagCategories must be a subset of categories`);
  }
  return cfg;
}

function positiveInt(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function unitInterval(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}

export const settings = {
  // Note: `||` (not `??`) throughout — GH Actions sets missing secrets to
  // empty strings, and Number("") is 0, which would zero the flag threshold.
  openrouterKey: env.OPENROUTER_API_KEY || "",
  visionModel: env.VISION_MODEL || "google/gemini-2.5-flash-lite",
  textModel: env.TEXT_MODEL || "google/gemini-2.5-flash-lite",
  // Jev via OpenRouter (typesafe/jev-router, $0.042/MTok in, output free).
  // Unset -> default to jev-router; set to "" -> pin to the LLM fallback.
  jevModel: env.JEV_MODEL === undefined ? "typesafe/jev-router" : env.JEV_MODEL,
  rsshubUrl: (env.RSSHUB_URL || "").replace(/\/+$/, ""),
  apifyToken: env.APIFY_API_TOKEN || "",
  // Optional direct TypeSafe API (reserved; unused while Jev routes via OpenRouter)
  jevUrl: (env.JEV_API_URL || "").replace(/\/+$/, ""),
  jevKey: env.JEV_API_KEY || "",
  zapierCatchUrl: (env.ZAPIER_CATCH_URL || "").replace(/\/+$/, ""),
  slackWebhookUrl: env.SLACK_WEBHOOK_URL || "",
  pizzabaseUrl: (env.PIZZABASE_API_URL || "").replace(/\/+$/, ""),
  pizzabaseKey: env.PIZZABASE_API_KEY || "",
  siteReportsMax: positiveInt(env.SITE_REPORTS_MAX, 50),
  dataDir: resolve(env.DATA_DIR || "./data"),
  flagConfidence: unitInterval(env.FLAG_CONFIDENCE, 0.7),
  maxPostsPerRun: positiveInt(env.MAX_POSTS_PER_RUN, 40),
  describeConcurrency: positiveInt(env.DESCRIBE_CONCURRENCY, 3),
};