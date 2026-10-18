import type { FlaggedItem, Notifier } from "../types.js";
import { settings } from "../config.js";
import { flagText } from "./format.js";

/** First embeddable image URL for a flagged post (fresh CDN URLs — hotlinked,
 *  never stored; video-only posts fall back to a link). */
export function flagMediaUrl(f: FlaggedItem): string | undefined {
  const imgs = f.description.item.mediaUrls.filter((u) => /\.(jpe?g|png|webp)([?#]|$)/i.test(u));
  return imgs[0] ?? f.description.item.mediaUrls[0] ?? undefined;
}

/** $0 alternative: Slack incoming webhook, no Zapier in the middle. */
export const slackNotifier: Notifier = {
  name: "slack-webhook",
  async notify(flag: FlaggedItem): Promise<void> {
    if (!settings.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL not configured");
    const image = flagMediaUrl(flag);
    const video = flag.description.item.videoUrl;
    const text = flagText(flag) + (image || video ? "" : "\n(no embeddable media)");
    const body: Record<string, unknown> = {
      text,
      username: "feedflag",
      icon_url: "https://github.com/pizza-to-the-polls.png",
      // Embed the post's own media (fresh signed CDN URLs, hotlinked not stored)
      attachments: image
        ? [{ color: "#E01B5D", fallback: flagText(flag), image_url: image }]
        : undefined,
    };
    const res = await fetch(settings.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  },
};