/**
 * Jev decision provider for location disambiguation (issue #35).
 *
 * Same division of labor as `src/classify/jev.ts`: Jev makes the *typed
 * decision* — which candidate location does this text describe, or none —
 * with calibrated confidence. String-in, typed-value-out; Jev never
 * generates the address string (that comes from the matched `locations` row
 * and human-facing text stays in `src/notify/format.ts`).
 *
 * Input: the message text (caption / hashtags / image-video descriptions /
 * govt raw point label) + the small candidate set from the deterministic
 * prefilter (≤ 25 — Jev's choice cardinality limit). Output:
 * `{ location_id | null, confidence }`.
 *
 * Failure semantics mirror `classify/index.ts`: a transport/parse error
 * throws, and the orchestrator degrades to the deterministic similarity pick
 * or a clean no-match — never a dropped or stalled observation.
 */
import { settings } from "../config.js";
import { openrouterChat } from "../describe/openrouter.js";
import type {
  CandidateLocation,
  LocationDecisionProvider,
} from "./types.js";

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Parse a Jev resolve response into a typed pick. `candidates` bounds the
 * choice — an id outside the candidate set is a contract violation (throw,
 * so the deterministic fallback takes over), not a match.
 */
export function parseJevResolveResponse(
  content: string,
  candidates: CandidateLocation[],
): { locationId: number | string | null; confidence: number } {
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first === -1 || last <= first)
    throw new Error(`unparseable jev-resolve response: ${content.slice(0, 120)}`);
  const j = JSON.parse(content.slice(first, last + 1)) as {
    location_id?: unknown;
    confidence?: unknown;
  };
  const conf = Number(j.confidence);
  const confidence = Number.isFinite(conf) ? clamp01(conf) : 0;
  if (j.location_id == null) return { locationId: null, confidence };
  const id = String(j.location_id);
  if (!candidates.some((c) => String(c.location_id) === id))
    throw new Error(
      `jev-resolve picked non-candidate id ${id} (of ${candidates.length})`,
    );
  return { locationId: j.location_id as number | string, confidence };
}

export const jevResolveProvider: LocationDecisionProvider = {
  name: "jev-resolve",
  async pick(text, candidates) {
    if (!settings.jevResolveModel)
      throw new Error("JEV_RESOLVE_MODEL not configured");
    if (!settings.openrouterKey)
      throw new Error("OPENROUTER_API_KEY not configured");
    const content = await openrouterChat({
      model: settings.jevResolveModel,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You are a typed decision system matching a polling-place mention " +
            "to the most likely location. Respond with strict JSON only: " +
            '{"location_id": <number or null>, "confidence": <calibrated 0..1>}. ' +
            "Pick the candidate the text actually describes by comparing the " +
            "mention against each candidate's name and address. If none fits, " +
            "return null for location_id with low confidence. Do not invent ids.",
        },
        {
          role: "user",
          content: JSON.stringify({
            mention_text: text,
            candidates: candidates.map((c) => ({
              location_id: c.location_id,
              name: c.name,
              address: c.address,
            })),
          }),
        },
      ],
    });
    return parseJevResolveResponse(content, candidates);
  },
};
