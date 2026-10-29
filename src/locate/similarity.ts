/**
 * Dependency-free string similarity for location matching (issue #35).
 *
 * Pure and deterministic — the fuzzy prefilter must stay cheap and offline
 * (no npm dep, no model call). Jaro-Winkler is a good fit for place names:
 * short strings, common prefixes ("Oakwood Community Center" vs
 * "Oakwood Elementary School"), typo-tolerant.
 */

/** Jaro similarity in [0, 1]. */
export function jaro(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (!bHit[j] && a[i] === b[j]) {
        aHit[i] = true;
        bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  // transpositions: matched pairs in different order, counted pairwise
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[j]) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  transpositions /= 2;
  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions) / m) / 3;
}

/** Jaro-Winkler similarity in [0, 1] — common prefixes get a boost. */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const j = jaro(a, b);
  if (j <= 0.7) return j;
  const maxPrefix = Math.min(4, a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return j + prefix * prefixScale * (1 - j);
}

/**
 * Normalization for place-name comparison: lowercase, drop parenthetical
 * point codes ("(P-2)"), strip punctuation, drop noise tokens (articles,
 * connectors, bare numbers). Both sides of a comparison go through this,
 * so the lossy transforms cancel out.
 */
export function normalizePlaceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (t) =>
        t !== "" &&
        t !== "the" &&
        t !== "at" &&
        t !== "a" &&
        t !== "an" &&
        t !== "of" &&
        t !== "and" &&
        !/^\d+$/.test(t),
    )
    .join(" ");
}

/** Confidence mapped from a similarity score: threshold floor (0.6) to 0.95
 *  at a perfect match. Round to 2 decimals for stable JSON output. */
export function confidenceFromScore(score: number): number {
  const floor = 0.6;
  const ceil = 0.95;
  const raw = floor + (ceil - floor) * ((score - 0.85) / 0.15);
  return Math.round(Math.min(ceil, Math.max(floor, raw)) * 100) / 100;
}
