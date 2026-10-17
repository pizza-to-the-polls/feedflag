import type { Classification, DecisionProvider, DescriptionSet } from "../types.js";
import { settings } from "../config.js";
import { renderInput } from "./render-input.js";

/**
 * JEV (TypeSafe AI "System One Model") decision provider.
 *
 * ⚠️ Waitlist requested 2026-12-04, access not yet granted, and JEV is NOT on
 * OpenRouter — direct API. The HTTP shape below is modeled on their published
 * docs ("typed decisions, calibrated confidence on every output, up to 255
 * choices"). Rewrite the transport when trial access lands; the rest of the
 * pipeline only depends on the DecisionProvider shape, per JEV_EXPLORATION.md.
 *
 * JEV cannot generate strings, so this decision only picks from the
 * configured category enum — the notify layer writes all human-facing text.
 */
export async function jevDecide(req: {
  decision: string;
  input: Record<string, string>;
  choices: string[];
}): Promise<{ choice: string; confidence: number }> {
  const res = await fetch(`${settings.jevUrl}/v1/decide`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.jevKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const j: any = await res.json();
  return {
    choice: String(j.choice ?? j.decision ?? j.category),
    confidence: Number(j.confidence ?? j.probability ?? 0),
  };
}

export const jevProvider: DecisionProvider = {
  name: "jev",
  async classify(d: DescriptionSet, categories: string[]): Promise<Classification> {
    if (!settings.jevUrl || !settings.jevKey) throw new Error("JEV_API_URL / JEV_API_KEY not configured");
    const { choice, confidence } = await jevDecide({
      decision: "social_feed_relevance",
      input: renderInput(d),
      choices: categories,
    });
    return {
      relevant: choice !== "irrelevant",
      confidence,
      category: choice,
      provider: "jev",
    };
  },
};