import type { FlaggedItem, Observation } from "../types.js";
import { excerpt } from "../util.js";
import { flagMediaUrl } from "./slack.js";

/** Lines >= this many minutes are the dispatch-relevant signal (1h).
 *  Shared by the crowd leg (pipeline) and the govt leg (extract-wait-times). */
export const MIN_POST_MINUTES = 60;

/** Ground-truth reports are vol-grade by definition (no graduated gating).
 *  Numeric value wins when present: "Less than one hour" normalizes to
 *  {0, "long"} — that is NOT dispatch-relevant. Category-only "long"
 *  (free text the LLM can't turn into minutes, e.g. "super long line")
 *  still qualifies. */
export function isDispatchRelevantWait(
  minutes: number | null | undefined,
  category: string | null | undefined,
): boolean {
  return (
    (minutes ?? -1) >= MIN_POST_MINUTES ||
    (minutes == null && category === "long")
  );
}

/**
 * Formats an Observation into a text suitable for Slack post when it's a dispatch-relevant wait time report.
 * Format:
 * :stopwatch: *Wait-time report* — <city>, <state>
 * • <location.raw or city>: <N min | long> (user-submitted report)
 * Source: <url>
 */
export function waitReportText(
  o: Partial<Observation> & { url?: string },
): string {
  const wait_minutes = o.wait_minutes ?? null;
  const wait_category = o.wait_category ?? null;
  const url = o.url ?? "";
  const loc = o.location ?? {};
  const city = loc.county;
  const state = loc.state;
  const place = loc.raw ?? city;
  const val =
    wait_minutes != null ? `${wait_minutes} min` : (wait_category ?? "?");
  const header = [city, state].filter(Boolean).join(", ");
  const source = url;

  return [
    `:stopwatch: *Wait-time report* — ${header}`,
    `• ${place}: ${val} (user-submitted report)`,
    `Source: ${source}`,
  ].join("\n");
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
  const link = f.item.url ?? "";
  return [head, who, body, media, link].filter(Boolean).join("\n");
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
  };
}
