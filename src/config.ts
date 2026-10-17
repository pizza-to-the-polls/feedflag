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
  return cfg;
}

export const settings = {
  openrouterKey: env.OPENROUTER_API_KEY ?? "",
  visionModel: env.VISION_MODEL ?? "google/gemini-2.5-flash-lite",
  textModel: env.TEXT_MODEL ?? "google/gemini-2.5-flash-lite",
  rsshubUrl: (env.RSSHUB_URL ?? "").replace(/\/+$/, ""),
  apifyToken: env.APIFY_API_TOKEN ?? "",
  jevUrl: (env.JEV_API_URL ?? "").replace(/\/+$/, ""),
  jevKey: env.JEV_API_KEY ?? "",
  zapierCatchUrl: env.ZAPIER_CATCH_URL ?? "",
  slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? "",
  pizzabaseUrl: (env.PIZZABASE_API_URL ?? "").replace(/\/+$/, ""),
  pizzabaseKey: env.PIZZABASE_API_KEY ?? "",
  siteReportsMax: Number(env.SITE_REPORTS_MAX ?? 50),
  dataDir: resolve(env.DATA_DIR ?? "./data"),
  flagConfidence: Number(env.FLAG_CONFIDENCE ?? 0.7),
  maxPostsPerRun: Number(env.MAX_POSTS_PER_RUN ?? 40),
  describeConcurrency: Number(env.DESCRIBE_CONCURRENCY ?? 3),
};