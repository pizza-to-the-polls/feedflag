import type { FlaggedItem, Notifier } from "../types.js";
import { settings } from "../config.js";
import { flagPayload } from "./format.js";

/**
 * Zapier leg: a single Zap — Trigger: "Catch Hook" (this POST is the payload)
 * -> (optional filter on category/confidence) -> Action: Slack "Send Channel
 * Message". Keeps all Slack routing/channel/digest logic in Zapier, out of
 * this codebase, at ~2-3 tasks per flagged post (see README cost table).
 */
export const zapierNotifier: Notifier = {
  name: "zapier-catch-hook",
  async notify(flag: FlaggedItem): Promise<void> {
    if (!settings.zapierCatchUrl) throw new Error("ZAPIER_CATCH_URL not configured");
    const res = await fetch(settings.zapierCatchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(flagPayload(flag)),
    });
    if (!res.ok) {
      throw new Error(`Zapier catch hook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  },
};