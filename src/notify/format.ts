import type { FlaggedItem } from "../types.js";
import { excerpt } from "../util.js";
import { flagMediaUrl } from "./slack.js";

/** Lines >= this many minutes are the dispatch-relevant signal (1h).
 *  Shared by the govt leg (extract-wait-times). Crowd reports never post to
 *  Slack — they already surface via the pizzabase Zapier report hooks. */
export const MIN_POST_MINUTES = 60;

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
