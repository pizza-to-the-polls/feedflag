/**
 * Place-mention extraction from an observation's text (issue #35).
 *
 * Deterministic, rule-based, cheap: no NER model, no LLM. The extracted
 * names feed the fuzzy prefilter (src/locate/fuzzy.ts) and, when ambiguous,
 * the Jev disambiguation call (src/locate/jev.ts). Sources of text:
 *
 * - social leg: caption, hashtags, vision/AI image-video descriptions
 * - govt leg: the source site's own raw point label ("Some Church (P-2)")
 *
 * House rule (JEV_EXPLORATION.md): this is string *analysis*, not string
 * generation — deterministic code, not the model.
 */
import type { DescriptionSet } from "../types.js";

/** Generic place-type words that make a capitalized run location-shaped. */
const PLACE_WORD_RE =
  /\b(church|schools?|library|libraries|centers?|centres?|halls?|academ(y|ies)|gym(nasium)?s?|pavilions?|auditoriums?|armor(y|ies)|annex(es)?|campus|precincts?|parks?|branches?|stadiums?|arenas?|community|recreation|elementary|middle|high|polling|voting|vote)\b/i;

/** Prepositions that introduce a place mention ("at Willow Creek"). */
const TRIGGER_RE =
  /^(at|near|from|outside|inside|around|by|off)$/i;

/** Lowercase connectors allowed inside a capitalized run ("Church of the
 *  Brethren"). */
const CONNECTORS = new Set(["of", "the", "and", "st", "dr", "mt", "fr", "on"]);

/** Tokens that never start/join a capitalized run. */
const STOP_CAPS = new Set(["i", "it", "it's", "a", "an"]);

/** Two-letter state codes (and a few country/code-like tokens) that appear
 *  capitalized in captions but are not place names. */
const STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
  "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc", "us", "usa", "govt", "gov",
]);

function stripToken(t: string): string {
  return t.replace(/^[^\w'’&.]+/, "").replace(/[^\w'’&.]+$/, "");
}

function isCapToken(t: string): boolean {
  return /^[A-Z][\w'’&.-]*$/.test(t);
}

/**
 * Extract place-name-like phrases from free text: capitalized runs that are
 * either preceded by a trigger preposition ("at First Baptist Church"),
 * contain/abut a place-type word ("Mitchell Community Center", "… at the
 * Oakwood community center"), or are multi-token names ("Willow Creek").
 */
export function extractPlaceNames(text: string): string[] {
  const out: string[] = [];
  if (!text?.trim()) return out;
  const clean = text
    .replace(/\(([^)]*)\)/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = clean.split(" ").map(stripToken).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const lc = t.toLowerCase();
    if (
      !isCapToken(t) ||
      STATE_CODES.has(lc) ||
      STOP_CAPS.has(lc) ||
      /^\d/.test(t)
    ) {
      i++;
      continue;
    }
    // grow the run: capitalized tokens joined by optional lowercase connectors
    const run: string[] = [];
    const pending: string[] = [];
    let j = i;
    while (j < tokens.length) {
      const tok = tokens[j]!;
      const tokLc = tok.toLowerCase();
      if (
        isCapToken(tok) &&
        !STATE_CODES.has(tokLc) &&
        !STOP_CAPS.has(tokLc) &&
        !/^\d/.test(tok)
      ) {
        run.push(...pending, tok);
        pending.length = 0;
        j++;
      } else if (CONNECTORS.has(tokLc) && run.length > 0) {
        pending.push(tok);
        j++;
      } else break;
    }
    const phrase = run.join(" ");
    const prev = i > 0 ? tokens[i - 1]! : "";
    const after = j < tokens.length ? tokens[j]! : "";
    const triggered = TRIGGER_RE.test(prev);
    const placey =
      PLACE_WORD_RE.test(phrase) || PLACE_WORD_RE.test(after);
    if (phrase && (triggered || placey || run.length >= 2)) {
      out.push(phrase);
    }
    i = j;
  }
  return out;
}

/** CamelCase hashtag → words: "#OakwoodCommunityCenter" → "Oakwood Community
 *  Center". Lowercase/ acronym hashtags pass through unchanged. */
export function hashtagWords(tag: string): string {
  return tag
    .replace(/^#+/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** The govt leg's raw point label minus its point code: "Some Church (P-2)"
 *  → "Some Church". The registry/fuzzy matchers want the name only. */
export function nameFromRawLabel(raw: string): string {
  return raw
    .replace(/\(([^)]*)\)/g, " $1 ")
    .replace(/\b(P|Poll|Point|Precinct|Code)[\s.-]*\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Structural input for mention extraction — satisfied by both legs:
 *  social passes the description set, govt passes the source's raw point
 *  label (and optional REST address). */
export interface MentionInput {
  description?:
    | Pick<
        DescriptionSet,
        "caption" | "imageDescriptions" | "videoSummary" | "item"
      >
    | null;
  rawLabel?: string | null;
  address?: string | null;
}

/**
 * All candidate place-mention strings for an observation, deduped
 * (normalized) and capped. Order carries no weight for scoring.
 */
export function extractMentions(input: MentionInput): string[] {
  const texts: string[] = [];
  const d = input.description;
  if (d?.caption) texts.push(d.caption);
  for (const tag of d?.item.hashtags ?? []) texts.push(hashtagWords(tag));
  if (d?.imageDescriptions?.length) texts.push(d.imageDescriptions.join(" "));
  if (d?.videoSummary) texts.push(d.videoSummary);
  if (input.rawLabel) texts.push(nameFromRawLabel(input.rawLabel));
  if (input.address) texts.push(input.address);
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const name of extractPlaceNames(text)) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(name);
      }
    }
  }
  return mentions.slice(0, 8);
}
