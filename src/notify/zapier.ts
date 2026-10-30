import type { FlaggedItem, HttpTransport, Notifier } from "../types.js";
import { settings, type Settings } from "../config.js";
import { flagPayload } from "./format.js";

/** Injection seams for tests (issue #56): override the Settings (catch URL)
 *  and/or the transport function. Production callers omit this and get the
 *  settings singleton + global fetch. */
export interface ZapierNotifierOptions {
  settings?: Settings;
  transport?: HttpTransport;
}

/**
 * Zapier leg: a single Zap — Trigger: "Catch Hook" (this POST is the payload)
 * -> (optional filter on category/confidence) -> Action: Slack "Send Channel
 * Message". Keeps all Slack routing/channel/digest logic in Zapier, out of
 * this codebase, at ~2-3 tasks per flagged post (see README cost table).
 */
export function createZapierNotifier(
  opts: ZapierNotifierOptions = {},
): Notifier {
  const s = opts.settings ?? settings;
  const doFetch = opts.transport ?? globalThis.fetch;
  return {
    name: "zapier-catch-hook",
    async notify(flag: FlaggedItem): Promise<void> {
      if (!s.zapierCatchUrl) throw new Error("ZAPIER_CATCH_URL not configured");
      const res = await doFetch(s.zapierCatchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(flagPayload(flag)),
      });
      if (!res.ok) {
        throw new Error(
          `Zapier catch hook ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
    },
    async postText(text: string): Promise<void> {
      if (!s.zapierCatchUrl)
        throw new Error("ZAPIER_CATCH_URL not configured for postText");
      const res = await doFetch(s.zapierCatchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        throw new Error(
          `Zapier catch hook ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
    },
  };
}

/** Production singleton — unchanged behaviour, global fetch. */
export const zapierNotifier: Notifier = createZapierNotifier();
