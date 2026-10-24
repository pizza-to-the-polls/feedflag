import type { DecisionProvider } from "../types.js";
import { settings } from "../config.js";
import { jevProvider } from "./jev.js";
import { llmFallbackProvider } from "./llm-fallback.js";

/**
 * JEV-first with LLM fallback — a failing decision layer never drops a post.
 * Jev (via OpenRouter, `typesafe/jev-router`) is primary while JEV_MODEL is
 * set; any Jev error (transport, parse, rate limit) degrades to the
 * flash-lite classifier so the pipeline keeps flowing. The provider name
 * records which leg produced each classification.
 */
function composite(
  jev: DecisionProvider,
  fallback: DecisionProvider,
): DecisionProvider {
  return {
    name: "jev+llm-fallback",
    async classify(d, categories) {
      try {
        return await jev.classify(d, categories);
      } catch (err) {
        console.warn(
          `[feedflag] jev classify failed (${String(err).slice(0, 120)}) — falling back to ${fallback.name}`,
        );
        const result = await fallback.classify(d, categories);
        return { ...result, provider: `${result.provider} (jev-fallback)` };
      }
    },
  };
}

export function resolveClassifier(): DecisionProvider {
  if (settings.jevModel && settings.openrouterKey) {
    return composite(jevProvider, llmFallbackProvider);
  }
  if (settings.openrouterKey) {
    console.warn(
      "[feedflag] JEV_MODEL empty — using LLM fallback (uncalibrated confidence)",
    );
    return llmFallbackProvider;
  }
  throw new Error(
    "No classifier configured: set OPENROUTER_API_KEY (and optionally JEV_MODEL)",
  );
}
