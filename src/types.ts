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
  /** Raw extraction evidence (govt leg, issue #12): raw REST field values
   *  (WAIT_TIME, Last_Refresh) + freshness/hours gate verdicts, so post-
   *  incident audits never need to re-query the source. Absent on social-leg
   *  descriptions. */
  evidence?: Record<string, unknown>;
}

export interface Classification {
  relevant: boolean;
  /** Calibrated 0..1 probability from JEV. NOT calibrated when provider is an LLM fallback. */
  confidence: number;
  category: string;
  provider: string;
}

/**
 * Resolved place for an observation (issue #35 — location triangulation).
 * Persisted additively inside `location.resolved` (JSONB): today's
 * `raw`/`county`/`state` fields stay exactly as they were. `method=no-match`
 * with confidence 0 is the normal outcome when nothing resolves.
 */
export interface ResolvedLocation {
  /** Physical address from the matched pizzabase `locations` row */
  address?: string;
  /** pizzabase `locations.id` */
  location_id?: number | string;
  /** pizzabase `locations.canonical_id` (dedupe grouping) */
  canonical_id?: string;
  /** Matched row's display name */
  name?: string;
  /** registry = exact wait_time_sources.location_id link; fuzzy = deterministic
   *  similarity pick (incl. recent-context tiebreak); jev = Jev decision among
   *  candidates; no-match = nothing resolved (raw label preserved). */
  method: "registry" | "fuzzy" | "jev" | "no-match";
  /** Calibrated 0..1 (0 for no-match) */
  confidence: number;
}

export interface FlaggedItem {
  item: FeedItem;
  description: DescriptionSet;
  classification: Classification;
  /** Set by the location-resolution step (issue #35) when the flagged post's
   *  place was resolved — feeds the Slack `place:` line. */
  resolvedLocation?: ResolvedLocation;
}

/** Swappable decision layer — JEV today, anything else later. */
export interface DecisionProvider {
  name: string;
  classify(d: DescriptionSet, categories: string[]): Promise<Classification>;
}

export interface Notifier {
  name: string;
  notify(flag: FlaggedItem): Promise<void>;
  postText(text: string): Promise<void>;
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
  /** Govt leg: the source's own point label (e.g. "Some Church (P-2)").
   *  Issue #35: the resolve step (src/locate/resolve.ts) adds `resolved` —
   *  the actual place behind the raw label / caption mention — additively. */
  location?: {
    raw?: string;
    state?: string;
    county?: string;
    precinct?: string;
    resolved?: ResolvedLocation;
  };
  /** Jev category, e.g. "poll_line_report" */
  signal_kind: string;
  /** Filled by a Phase-3-style extractor; empty from the social leg today.
   *  null = the govt leg observed "no wait data" (bus-record shape). */
  wait_minutes?: number | null;
  wait_category?: string | null;
  confidence: number;
  provider: string;
  relevant: boolean;
  /** Full description set — the `raw_json` pattern, kept for downstream debugging */
  description: DescriptionSet;
}
