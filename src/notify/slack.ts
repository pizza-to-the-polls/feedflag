import type { FlaggedItem, Notifier } from "../types.js";
import { settings } from "../config.js";
import { flagText } from "./format.js";

/** $0 alternative: Slack incoming webhook, no Zapier in the middle. */
export const slackNotifier: Notifier = {
  name: "slack-webhook",
  async notify(flag: FlaggedItem): Promise<void> {
    if (!settings.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL not configured");
    const res = await fetch(settings.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: flagText(flag),
        username: "feedflag",
        icon_url: "https://github.com/pizza-to-the-polls.png",
      }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  },
};