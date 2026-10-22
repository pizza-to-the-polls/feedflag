import type { FlaggedItem, Notifier } from "../types.js";
import { settings } from "../config.js";
import { flagText } from "./format.js";

/** First embeddable image URL for a flagged post (fresh CDN URLs — hotlinked,
 *  never stored; video-only posts fall back to a link). */
export function flagMediaUrl(f: FlaggedItem): string | undefined {
  const imgs = f.description.item.mediaUrls.filter((u) => /\.(jpe?g|png|webp)([?#]|$)/i.test(u));
  return imgs[0] ?? f.description.item.mediaUrls[0] ?? undefined;
}

/**
 * Slack notifier — prefers the BOT APP identity (chat.postMessage with the
 * app's own uploaded icon + name, no icon_url override) when SLACK_BOT_TOKEN
 * is set; falls back to the incoming webhook (icon via icon_url override —
 * webhooks can't read the app's uploaded icon, hence the upgrade).
 *
 * Bot path also gets attachments (media previews) for richer flags.
 */
export const slackNotifier: Notifier = {
  name: "slack",
  async notify(flag: FlaggedItem): Promise<void> {
    const text = flagText(flag);
    const image = flagMediaUrl(flag);
    // Bot path: post as the app identity (icon from app settings)
    if (settings.slackBotToken && settings.slackFlagChannels.length) {
      for (const channel of settings.slackFlagChannels) {
        const body: Record<string, unknown> = {
          channel,
          text,
          unfurl_links: false,
          ...(image ? { blocks: undefined } : {}),
        };
        if (image) {
          body.attachments = [{ color: "#E01B5D", fallback: "flagged media", image_url: image }];
        }
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            authorization: `Bearer ${settings.slackBotToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          throw new Error(`Slack chat.postMessage ${res.status} (ch ${channel})`);
        }
      }
      return;
    }
    // Webhook path (fallback)
    const url = settings.volsWebhookUrl || settings.slackWebhookUrl;
    if (!url) throw new Error("No Slack delivery configured");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, username: "feedflag", icon_emoji: ":feedflag:" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  },
};