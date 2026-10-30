import type {
  Classification,
  DecisionProvider,
  DescriptionSet,
} from "../types.js";
import { settings } from "../config.js";
import { openrouterChat } from "../describe/openrouter.js";
import { renderInput } from "./render-input.js";

/**
 * Jev (TypeSafe AI "System One Model") decision provider, via OpenRouter
 * (model: `typesafe/jev-router`, $0.042/MTok input, output free).
 *
 * Jev returns typed decisions with calibrated confidence in ~100ms — no
 * strings, no prose. The `jev-router` model handles the decision routing;
 * we hand it the flattened description set (text only — the vision model
 * already stood in for the media) plus the category enum, and parse a
 * category pick + confidence out of the response.
 *
 * If the response shape isn't what we expect, we throw — the composite
 * provider in `classify/index.ts` falls back to the LLM classifier, so a
 * Jev transport hiccup never drops a post.
 */

export interface JevChoice {
  category: string;
  confidence: number;
}

export function parseJevResponse(
  content: string,
  categories: string[],
): JevChoice {
  // Try strict JSON first: {"category": "...", "confidence": 0.82}
  const candidates: string[] = [];
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first)
    candidates.push(content.slice(first, last + 1));
  // Then a bare "category: 0.82" style line, and any JSON object in the text
  for (const candidate of candidates) {
    try {
      const j = JSON.parse(candidate) as {
        category?: unknown;
        confidence?: unknown;
      };
      if (typeof j.category === "string" && categories.includes(j.category)) {
        const conf = Number(j.confidence);
        return {
          category: j.category,
          confidence: Number.isFinite(conf)
            ? Math.min(Math.max(conf, 0), 1)
            : 0,
        };
      }
    } catch {
      // try next candidate
    }
  }
  // Last resort: scan for a category mention + a float near it
  for (const c of categories) {
    const idx = content.indexOf(c);
    if (idx !== -1) {
      const tail = content.slice(idx + c.length, idx + c.length + 40);
      const m = tail.match(/(\d?\.\d+)/);
      return { category: c, confidence: m ? Number(m[1]) : 0 };
    }
  }
  throw new Error(`unparseable Jev response: ${content.slice(0, 120)}`);
}

export const jevProvider: DecisionProvider = {
  name: "jev",
  async classify(
    d: DescriptionSet,
    categories: string[],
  ): Promise<Classification> {
    if (!settings.jevModel) throw new Error("JEV_MODEL not configured");
    if (!settings.openrouterKey)
      throw new Error("OPENROUTER_API_KEY not configured");
    const content = await openrouterChat({
      model: settings.jevModel,
      messages: [
        {
          role: "system",
          content:
            "You are a typed decision system classifying social-media posts about voting. " +
            "Respond with strict JSON only: " +
            '{"category": <one of [' +
            categories.map((c) => `"${c}"`).join(", ") +
            ']>, "confidence": <calibrated 0..1 probability that the category is correct>}. ' +
            "Confidence must reflect actual uncertainty: high (>=0.9) only when the evidence " +
            "unambiguously supports the category. RULES: " +
            "ALL categories require a US election post — non-US posts (Pakistan, " +
            "Canada, UK, etc.) are ALWAYS irrelevant. " +
            "poll_line_report / wait_time_page_mention additionally require " +
            "(1) explicit evidence of a physical line, queue, " +
            "or wait at a specific polling place (generic #ivoted civic-pride posts do NOT " +
            "count), and (2) NOT news/press coverage of lines (news coverage -> press_mention). " +
            "When in doubt, choose irrelevant with low confidence.",
        },
        {
          role: "user",
          content: JSON.stringify(renderInput(d), null, 2),
        },
      ],
    });
    const { category, confidence } = parseJevResponse(content, categories);
    return {
      relevant: category !== "irrelevant",
      confidence,
      category,
      provider: `jev:${settings.jevModel}`,
    };
  },
};
