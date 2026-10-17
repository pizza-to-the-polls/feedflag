import { openrouterChat } from "../describe/openrouter.js";
import { settings } from "../config.js";

/**
 * Shared free-text -> structured wait-time normalizer.
 *
 * This is string-generation work ("20-30 min" -> 25), so it's LLM-side —
 * Jev can't generate strings (JEV_EXPLORATION.md §2). Used by BOTH the
 * crowd leg (Report.waitTime is free text) and the future govt extraction
 * leg — same patterns, one prompt (GOVT_WAIT_TIME_SOURCES_PLAN.md §5 table).
 */
export interface NormalizedWait {
  wait_minutes?: number;
  wait_category?: "short" | "medium" | "long";
}

export async function normalizeWaitText(text: string): Promise<NormalizedWait> {
  const t = text?.trim();
  if (!t) return {};
  let raw: string;
  try {
    raw = await openrouterChat({
    model: settings.textModel,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Normalize a polling-place wait-time description. Respond with strict JSON: ' +
          '{"wait_minutes": <int minutes or null>, "wait_category": <"short"|"medium"|"long"|null>}. ' +
          'Rules: a range like "20-30 min" -> midpoint (25). Categorical words ("short","moderate","long") ' +
          '-> wait_category. "N people in line" -> ~N minutes. If unparseable, both null.',
      },
      { role: "user", content: t },
    ],
    });
  } catch {
    // Ground-truth reports must survive normalizer hiccups — emit with
    // wait_minutes unset rather than dropping the observation.
    return {};
  }
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      wait_minutes?: number | string | null;
      wait_category?: string | null;
    };
    const minutes = Number(j.wait_minutes);
    const cat = ["short", "medium", "long"].includes(String(j.wait_category))
      ? (String(j.wait_category) as NormalizedWait["wait_category"])
      : undefined;
    return {
      wait_minutes: Number.isFinite(minutes) ? minutes : undefined,
      wait_category: cat,
    };
  } catch {
    return {};
  }
}