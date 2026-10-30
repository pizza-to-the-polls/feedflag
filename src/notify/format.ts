import { settings } from "../config.js";
import type { FlaggedItem } from "../types.js";
import { excerpt } from "../util.js";
import { flagMediaUrl } from "./slack.js";

/** Lines >= this many minutes are the dispatch-relevant signal (1h).
 *  Shared by the govt leg (extract-wait-times). Crowd reports never post to
 *  Slack — they already surface via the pizzabase Zapier report hooks. */
export const MIN_POST_MINUTES = 60;

/** Hard floor for showing the resolved place on a flag (issue #35): below
 *  this the triangulated match is too shaky to act on, whatever the config
 *  says. `confidenceFromScore` maps the 0.85 similarity threshold to exactly
 *  0.6, so a bare-threshold fuzzy match sits right on this line. */
export const PLACE_SHOW_CONFIDENCE = 0.6;

/**
 * The effective floor: the configured `RESOLVE_SLACK_MIN_CONFIDENCE` (default
 *  0.8), never lower than `PLACE_SHOW_CONFIDENCE`.
 *
 * The setting used to be declared in `src/config.ts` and read nowhere — the
 * gate was this file's hardcoded 0.6 alone, so the knob was dead and an
 * operator raising it would have seen no effect. `Math.max` keeps the hard
 * floor authoritative while making the setting live.
 */
export function placeShowFloor(): number {
  return Math.max(PLACE_SHOW_CONFIDENCE, settings.resolveSlackMinConfidence);
}

/** True when a resolved location is confident enough to show volunteers. The
 *  single gate for both the human-readable line and the flat payload field,
 *  so Zapier cannot surface a place that `flagText` suppressed. */
export function placeIsShowable(f: FlaggedItem): boolean {
  const r = f.resolvedLocation;
  return Boolean(
    r &&
    r.method !== "no-match" &&
    r.confidence >= placeShowFloor() &&
    (r.address || r.name),
  );
}

/** The resolved-place line for a flag, e.g. "place: 123 Main St (fuzzy
 *  match)" — empty when nothing resolved (or the match is too shaky). */
export function placeLine(f: FlaggedItem): string {
  const r = f.resolvedLocation;
  if (!placeIsShowable(f)) return "";
  return `place: ${r!.address || r!.name} (${r!.method} match)`;
}

/** Human-facing message text. JEV can't write strings, so this stays here. */
export function flagText(f: FlaggedItem): string {
  const c = f.classification;
  const head = `🚩 *${c.category}* — ${(c.confidence * 100).toFixed(0)}% conf (${c.provider})`;
  const who = `@${f.item.authorHandle} on ${f.item.platform}`;
  const body = excerpt(f.description.caption || "(no caption)", 400);
  const media = f.description.imageDescriptions.length
    ? `Images: ${excerpt(f.description.imageDescriptions.join(" | "), 300)}`
    : "";
  const place = placeLine(f);
  const link = f.item.url ?? "";
  return [head, who, body, media, place, link].filter(Boolean).join("\n");
}

/** Flat JSON payload — Zapier maps fields from this into Slack steps. */
export function flagPayload(f: FlaggedItem): Record<string, unknown> {
  return {
    text: flagText(f),
    platform: f.item.platform,
    author: f.item.authorHandle,
    url: f.item.url ?? "",
    posted_at: f.item.postedAt,
    category: f.classification.category,
    confidence: f.classification.confidence,
    provider: f.classification.provider,
    caption: f.description.caption,
    image_descriptions: f.description.imageDescriptions,
    media_urls: f.description.item.mediaUrls,
    media_embed: flagMediaUrl(f) ?? "", // Zapier Slack step can use this directly
    // Issue #35: the triangulated place — gated by the SAME floor as the
    // `place:` line above, so a low-confidence pick cannot reach Slack through
    // this field after being suppressed in the text.
    resolved_place: placeIsShowable(f)
      ? f.resolvedLocation!.address || f.resolvedLocation!.name || ""
      : "",
    resolved_place_method: f.resolvedLocation?.method ?? "",
    resolved_place_confidence: f.resolvedLocation?.confidence ?? 0,
  };
}
