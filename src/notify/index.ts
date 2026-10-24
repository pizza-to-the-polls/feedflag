import type { Notifier } from "../types.js";
import { settings } from "../config.js";
import { zapierNotifier } from "./zapier.js";
import { slackNotifier } from "./slack.js";

/**
 * Zapier-first (routing stays in Zapier: channels, digests, escalation).
 * Falls back to a direct Slack webhook when no catch hook is configured.
 */
export function resolveNotifier(): Notifier | null {
  if (settings.zapierCatchUrl) return zapierNotifier;
  if (settings.slackWebhookUrl) {
    console.warn(
      "[feedflag] ZAPIER_CATCH_URL unset — posting direct to Slack webhook",
    );
    return slackNotifier;
  }
  return null;
}
