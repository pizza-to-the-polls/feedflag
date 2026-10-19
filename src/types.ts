export type Platform = "instagram" | "x" | "tiktok" | "site";

export interface FeedItem {
  /** Provider-unique id, used for dedupe */
  id: string;
  platform: Platform;
  authorHandle: string;
  /** ISO timestamp */
  postedAt: string;
  /** Author-written text (no HTML) */
  caption: string;
  hashtags: string[];
  /** Permalink to the original post */
  url?: string;
  /** Actor-provided AI description of a video (clockworks videoMeta.aiVideoDescription) — feeds the description set without vision captioning */
  aiSummary?: string;
  /** Image URLs (videos are handled via videoUrl -> ffmpeg frame) */
  mediaUrls: string[];
  videoUrl?: string;
  /** Which source produced this (for logging) */
  source: string;
}

/**
 * The "description set" handed to JEV: JEV is text-only (no images), so the
 * vision model's output stands in for the media. Strings only.
 */
export interface DescriptionSet {
  item: FeedItem;
  caption: string;
  imageDescriptions: string[];
  videoSummary?: string;
}

export interface Classification {
  relevant: boolean;
  /** Calibrated 0..1 probability from JEV. NOT calibrated when provider is an LLM fallback. */
  confidence: number;
  category: string;
  provider: string;
}

export interface FlaggedItem {
  item: FeedItem;
  description: DescriptionSet;
  classification: Classification;
}

/** Swappable decision layer — JEV today, anything else later. */
export interface DecisionProvider {
  name: string;
  classify(d: DescriptionSet, categories: string[]): Promise<Classification>;
}

export interface Notifier {
  name: string;
  notify(flag: FlaggedItem): Promise<void>;
}

/** Source domain — the aggregator joins social signals, gov-page extractions, and site reports. */
export type SignalDomain = "social" | "govt" | "crowd";

/**
 * Normalized, aggregator-ready record — feedflag's primary output once the
 * nationwide polling-place status aggregator (GOVT_WAIT_TIME_SOURCES_PLAN.md
 * Phases 2-4) consumes this stream. Shaped to load into pizzabase
 * `wait_time_readings` rows with `source_type='social'`.
 */
export interface Observation {
  schema: "feedflag/observation@1";
  domain: SignalDomain;
  /** ingest adapter that produced it, e.g. "apify:clockworks/tiktok-scraper" */
  source_ref: string;
  url?: string;
  author?: string;
  platform?: string;
  observed_at: string;
  posted_at?: string;
  /** Filled by downstream location matching (retrieve-then-match) */
  location?: { raw?: string; state?: string; county?: string; precinct?: string };
  /** Jev category, e.g. "poll_line_report" */
  signal_kind: string;
  /** Filled by a Phase-3-style extractor; empty from the social leg today */
  wait_minutes?: number;
  wait_category?: string;
  confidence: number;
  provider: string;
  relevant: boolean;
  /** Full description set — the `raw_json` pattern, kept for downstream debugging */
  description: DescriptionSet;
}