/**
 * County/state scope derivation from free text (issue #35).
 *
 * The fuzzy match against pizzabase `locations` is only trustworthy when
 * constrained to the observation's geographic scope — a nationwide pool
 * surfaces same-named places in different counties (two "St. Synthetic
 * Church" rows, two counties over, must never win). Sources of scope, in
 * priority order (the orchestrator applies the fallbacks):
 *
 * 1. govt leg: the source config's own state/county (scopeHint)
 * 2. social leg: hashtags / caption text ("#tx", "Fake County", "#GuilfordCounty")
 * 3. recent context: what this author/source has recently been observed discussing
 *
 * Pure and deterministic — string analysis, not generation (house rule).
 */
import type { LocationRow, LocationScope } from "./types.js";

/** Two-letter code → full name. Multi-word names must be checked before
 *  their embedded shorter names ("West Virginia" before "Virginia"), so the
 *  table is ordered accordingly (WV precedes VA). */
const STATES: [string, string][] = [
  ["AK", "alaska"],
  ["AZ", "arizona"],
  ["AR", "arkansas"],
  ["CA", "california"],
  ["CO", "colorado"],
  ["CT", "connecticut"],
  ["DE", "delaware"],
  ["FL", "florida"],
  ["GA", "georgia"],
  ["HI", "hawaii"],
  ["ID", "idaho"],
  ["IL", "illinois"],
  ["IA", "iowa"],
  ["KS", "kansas"],
  ["KY", "kentucky"],
  ["LA", "louisiana"],
  ["ME", "maine"],
  ["MD", "maryland"],
  ["MA", "massachusetts"],
  ["MI", "michigan"],
  ["MN", "minnesota"],
  ["MS", "mississippi"],
  ["MO", "missouri"],
  ["MT", "montana"],
  ["NE", "nebraska"],
  ["NV", "nevada"],
  ["NH", "new hampshire"],
  ["NJ", "new jersey"],
  ["NM", "new mexico"],
  ["NY", "new york"],
  ["NC", "north carolina"],
  ["ND", "north dakota"],
  ["OH", "ohio"],
  ["OK", "oklahoma"],
  ["OR", "oregon"],
  ["PA", "pennsylvania"],
  ["RI", "rhode island"],
  ["SC", "south carolina"],
  ["SD", "south dakota"],
  ["TN", "tennessee"],
  ["TX", "texas"],
  ["UT", "utah"],
  ["VT", "vermont"],
  ["WA", "washington"],
  ["WV", "west virginia"],
  ["VA", "virginia"],
  ["WI", "wisconsin"],
  ["WY", "wyoming"],
  ["AL", "alabama"],
  ["DC", "district of columbia"],
];

/** Codes that double as common English words when lowercased ("in line",
 *  "or", "ok", "hi", "me", "voter id") — these only count in their
 *  uppercase form. */
const AMBIGUOUS_CODES = new Set([
  "IN",
  "OK",
  "OR",
  "ME",
  "HI",
  "DE",
  "LA",
  "ID",
]);

/** Title-case run followed by the literal word "County": "Fake County",
 *  "Guilford County". Hashtag camelCase is split upstream (#GuilfordCounty
 *  → "Guilford County"), so this also catches hashtag county mentions. */
const COUNTY_RE = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+County\b/;

/** Drop punctuation + a trailing "county" so "Fake County", "Fake" and
 *  "FAKE COUNTY" compare equal. */
export function normCounty(c: string | undefined | null): string {
  return (c ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+county\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a county/state scope from free text. Empty object when nothing
 * location-shaped appears — the caller falls back to recent context.
 */
export function deriveScope(text: string): LocationScope {
  const out: LocationScope = {};
  if (!text?.trim()) return out;
  const county = COUNTY_RE.exec(text)?.[1];
  if (county) out.county = county.trim();
  for (const [code, name] of STATES) {
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) {
      out.state = code;
      break;
    }
    const flags = AMBIGUOUS_CODES.has(code) ? "" : "i";
    const m = new RegExp(`\\b${code}\\b`, flags).exec(text);
    if (m) {
      out.state = code;
      break;
    }
  }
  return out;
}

/**
 * Client-side scope constraint on `locations` rows. The pizzabase lookup is
 * asked to scope server-side, but the endpoint contract is not guaranteed —
 * this re-check keeps same-name rows in other counties/states out of the
 * candidate pool. Rows missing the field pass (endpoint tolerance); rows
 * carrying a conflicting value are dropped (the AC's cross-county trap).
 */
export function scopeMatchesRow(
  row: LocationRow,
  scope: LocationScope,
): boolean {
  const state = scope.state?.trim().toUpperCase();
  if (state && row.state && row.state.trim().toUpperCase() !== state)
    return false;
  const county = normCounty(scope.county);
  if (county && row.county && normCounty(row.county) !== county) return false;
  return true;
}
