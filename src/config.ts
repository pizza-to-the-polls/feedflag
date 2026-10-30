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
  /** Author handles to skip entirely (case-insensitive, no @) — our own
   *  accounts' outreach replies are never signal (2026-10-30: PTP's own
   *  "report it!" replies were being flagged as wait_time_page_mention). */
  ignoredAuthors?: string[];
}

function positiveInt(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function unitInterval(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}

/** Runtime configuration — exactly the shape the module-level `settings`
 *  singleton has always exposed (issue #41): every field, every type. */
export interface Settings {
  openrouterKey: string;
  visionModel: string;
  textModel: string;
  // Jev via OpenRouter (typesafe/jev-router, $0.042/MTok in, output free).
  // Unset -> default to jev-router; set to "" -> pin to the LLM fallback.
  jevModel: string;
  // Issue #35 location-resolution Jev calls. Defaults to the classify model.
  // Set JEV_RESOLVE_MODEL="" to disable model-assisted disambiguation (the
  // deterministic similarity + recent-context chain still runs).
  jevResolveModel: string;
  rsshubUrl: string;
  apifyToken: string;
  // Optional direct TypeSafe API (reserved; unused while Jev routes via OpenRouter)
  jevUrl: string;
  jevKey: string;
  zapierCatchUrl: string;
  slackWebhookUrl: string;
  volsWebhookUrl: string;
  slackBotToken: string;
  slackFlagChannels: string[];
  pizzabaseUrl: string;
  pizzabaseKey: string;
  siteReportsMax: number;
  dataDir: string;
  flagConfidence: number;
  maxPostsPerRun: number;
  describeConcurrency: number;
  // Issue #35 location triangulation: candidate prefilter cap (top-K rows
  // handed to Jev) and per-observation resolve concurrency.
  resolveConcurrency: number;
  resolveMaxCandidates: number;
  // Cap on rows fetched from pizzabase /locations when no county/state scope
  // is available (unscoped social mentions) — budget guard for the lookup.
  resolveLocationsLimit: number;
  // Issue #35: below this resolved-confidence the Slack flag omits the
  // `place:` line (low-confidence fuzzy picks stay off the volunteer feed).
  resolveSlackMinConfidence: number;
  // Per-run cap on model-assisted (Jev) disambiguation calls in the location
  // resolver — registry joins + deterministic similarity picks cost nothing;
  // only ambiguous mentions (0.85 <= score, no clear winner) reach Jev.
  resolveJevMaxCalls: number;
}

/** Build the Settings object from the given env (default: process.env).
 *  Same logic — and the same two deliberate subtleties — as the historical
 *  module-level singleton (issue #41). */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // Note: `||` (not `??`) throughout — GH Actions sets missing secrets to
  // empty strings, and Number("") is 0, which would zero the flag threshold.
  // Jev model slug shared by classify + resolve (issue #35) so one env var
  // controls both; JEV_RESOLVE_MODEL overrides the resolve leg only.
  const jevModel =
    env.JEV_MODEL === undefined ? "typesafe/jev-router" : env.JEV_MODEL;

  return {
    openrouterKey: env.OPENROUTER_API_KEY || "",
    visionModel: env.VISION_MODEL || "google/gemini-2.5-flash-lite",
    textModel: env.TEXT_MODEL || "google/gemini-2.5-flash-lite",
    // Unset -> default to jev-router; set to "" -> pin to the LLM fallback.
    jevModel: jevModel,
    // Issue #35 location-resolution Jev calls. Defaults to the classify model.
    // Set JEV_RESOLVE_MODEL="" to disable model-assisted disambiguation (the
    // deterministic similarity + recent-context chain still runs).
    jevResolveModel:
      env.JEV_RESOLVE_MODEL === undefined ? jevModel : env.JEV_RESOLVE_MODEL,
    rsshubUrl: (env.RSSHUB_URL || "").replace(/\/+$/, ""),
    apifyToken: env.APIFY_API_TOKEN || "",
    jevUrl: (env.JEV_API_URL || "").replace(/\/+$/, ""),
    jevKey: env.JEV_API_KEY || "",
    zapierCatchUrl: (env.ZAPIER_CATCH_URL || "").replace(/\/+$/, ""),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || "",
    volsWebhookUrl: env.SLACK_VOLS_WEBHOOK_URL || "",
    slackBotToken: env.SLACK_BOT_TOKEN || "",
    slackFlagChannels: (env.SLACK_FLAG_CHANNELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pizzabaseUrl: (env.PIZZABASE_API_URL || "").replace(/\/+$/, ""),
    pizzabaseKey: env.PIZZABASE_API_KEY || "",
    siteReportsMax: positiveInt(env.SITE_REPORTS_MAX, 50),
    dataDir: resolve(env.DATA_DIR || "./data"),
    flagConfidence: unitInterval(env.FLAG_CONFIDENCE, 0.7),
    maxPostsPerRun: positiveInt(env.MAX_POSTS_PER_RUN, 40),
    describeConcurrency: positiveInt(env.DESCRIBE_CONCURRENCY, 3),
    resolveConcurrency: positiveInt(env.RESOLVE_CONCURRENCY, 3),
    resolveMaxCandidates: positiveInt(env.RESOLVE_MAX_CANDIDATES, 25),
    resolveLocationsLimit: positiveInt(env.RESOLVE_LOCATIONS_LIMIT, 5000),
    resolveSlackMinConfidence: unitInterval(
      env.RESOLVE_SLACK_MIN_CONFIDENCE,
      0.8,
    ),
    resolveJevMaxCalls: positiveInt(env.RESOLVE_JEV_MAX_CALLS, 200),
  };
}

const env = process.env;

/** The singleton, still a plain mutable object (tests mutate it — see
 *  scripts/test-locate.ts) so every existing importer keeps working. */
export const settings = loadSettings();

export function loadFeedsConfig(): FeedsConfig {
  const path = resolve(env.FEEDS_CONFIG ?? "./config/feeds.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as FeedsConfig;
  if (!cfg.sources?.length) throw new Error(`No sources in ${path}`);
  if (!cfg.categories?.length) throw new Error(`No categories in ${path}`);
  if (cfg.categories.length > 255) {
    throw new Error(
      `categories.length=${cfg.categories.length} > 255 (Jev decision cardinality limit)`,
    );
  }
  if (
    cfg.flagCategories &&
    !cfg.flagCategories.every((c) => cfg.categories.includes(c))
  ) {
    throw new Error(`flagCategories must be a subset of categories`);
  }
  return cfg;
}
