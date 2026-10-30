import type {
  Classification,
  DecisionProvider,
  DescriptionSet,
} from "../types.js";
import { settings } from "../config.js";
import {
  openrouterChat,
  type OpenRouterChatOptions,
} from "../describe/openrouter.js";
import { renderInput } from "./render-input.js";

/**
 * Fallback decision provider for until JEV access lands: a cheap text LLM.
 *
 * NOTE: LLM "confidence" is NOT calibrated (unlike JEV). Keep FLAG_CONFIDENCE
 * lower for this provider, and treat the number as a rough score. Once JEV is
 * live this file stays as the emergency fallback behind the same interface.
 *
 * Injectable via `createLlmFallbackProvider({ settings, transport })` so tests
 * can drive the parse-fail path without a live key or network (issue #41);
 * the `llmFallbackProvider` singleton is the zero-argument default.
 */
export function createLlmFallbackProvider(
  opts: OpenRouterChatOptions = {},
): DecisionProvider {
  const s = opts.settings ?? settings;
  return {
    name: `llm-fallback:${s.textModel}`,
    async classify(
      d: DescriptionSet,
      categories: string[],
    ): Promise<Classification> {
      const raw = await openrouterChat(
        {
          model: s.textModel,
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Classify a social-media post for relevance. " +
                `Respond with strict JSON: {"category": <one of ${categories.map((c) => `"${c}"`).join(", ")}>, ` +
                `"relevant": <boolean>, "confidence": <0..1 float reflecting how well the evidence supports the category>}. ` +
                `Use category "irrelevant" unless the post matches one of the other categories. ` +
                "RULES: ALL categories require a US election post — non-US posts (Pakistan, " +
                "Canada, UK, etc.) are ALWAYS irrelevant regardless of category. " +
                "poll_line_report / wait_time_page_mention additionally require explicit " +
                "line/queue/wait evidence at a specific polling place, and NOT news coverage " +
                "(news -> press_mention). Generic #ivoted civic-pride -> irrelevant.",
            },
            { role: "user", content: JSON.stringify(renderInput(d)) },
          ],
        },
        { settings: s, transport: opts.transport },
      );
      const fallback: Classification = {
        relevant: false,
        confidence: 0,
        category: "irrelevant",
        provider: `${s.textModel}:parse-fail`,
      };
      try {
        const j = JSON.parse(
          raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
        ) as {
          category?: string;
          relevant?: boolean;
          confidence?: number | string;
        };
        const category = categories.includes(String(j.category))
          ? String(j.category)
          : "irrelevant";
        return {
          relevant:
            typeof j.relevant === "boolean"
              ? j.relevant
              : category !== "irrelevant",
          confidence: Math.max(0, Math.min(1, Number(j.confidence ?? 0))),
          category,
          provider: s.textModel,
        };
      } catch {
        return fallback;
      }
    },
  };
}

export const llmFallbackProvider: DecisionProvider =
  createLlmFallbackProvider();
