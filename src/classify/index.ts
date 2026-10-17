import type { DecisionProvider } from "../types.js";
import { settings } from "../config.js";
import { jevProvider } from "./jev.js";
import { llmFallbackProvider } from "./llm-fallback.js";

/**
 * JEV-first, fallback behind the same interface — never a hard dependency
 * on TypeSafe while they're pre-track-record (see JEV_EXPLORATION.md §3).
 */
export function resolveClassifier(): DecisionProvider {
  if (settings.jevUrl && settings.jevKey) return jevProvider;
  if (settings.openrouterKey) {
    console.warn("[feedflag] JEV not configured — using LLM fallback (uncalibrated confidence)");
    return llmFallbackProvider;
  }
  throw new Error("No classifier configured: set JEV_API_URL+JEV_API_KEY or OPENROUTER_API_KEY");
}