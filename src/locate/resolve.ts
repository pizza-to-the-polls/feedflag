/**
 * Location triangulation orchestrator (issue #35).
 *
 * Resolves the actual place being discussed on every incoming social/govt
 * observation, additively: `location.resolved` on the observation JSONB.
 * Resolution chain, cheapest first:
 *
 *  1. REGISTRY (govt only): a registered `wait_time_sources.location_id` —
 *     exact link, confidence 0.97, no fuzzy fallback.
 *  2. SCOPE: county/state constraint — govt scopeHint, else derived from the
 *     message text ("#tx", "Fake County"), else the author/source's recent
 *     observations.
 *  3. FUZZY prefilter: normalized Jaro-Winkler over scoped `locations` rows
 *     (src/locate/fuzzy.ts); a clear winner is accepted deterministically.
 *  4. CONTEXT tiebreak: when the table is ambiguous, the place the same
 *     author/source has recently been discussing wins.
 *  5. JEV disambiguation: still ambiguous → typed decision over the ≤25
 *     candidates ({location_id | null, confidence}) — string in, typed value
 *     out, no generated strings (JEV_EXPLORATION.md).
 *  6. NO-MATCH: nothing above fired. Normal outcome — the raw label is kept
 *     verbatim and ingestion is never blocked or failed by this step.
 *
 * Every failure degrades (providers already fail-soft; this function also
 * never throws): a resolution problem can only ever cost the resolved block,
 * never the observation.
 */
import { settings, type Settings } from "../config.js";
import type {
  DescriptionSet,
  Observation,
  ResolvedLocation,
} from "../types.js";
import { extractMentions, hashtagWords } from "./candidates.js";
import {
  CONTEXT_LIMIT,
  LocalBusContextProvider,
  applyContextTiebreak,
  contextResolved,
  contextScope,
} from "./context.js";
import {
  MAX_CANDIDATES,
  isClearWinner,
  rankCandidates,
  resolvedFromRow,
  resolvedFromScore,
  rowId,
  toCandidate,
} from "./fuzzy.js";
import { jevResolveProvider } from "./jev.js";
import { PizzabaseApi } from "./pizzabase-api.js";
import { deriveScope, scopeMatchesRow } from "./scope.js";
import type { LocationRow, LocationScope, ResolveDeps } from "./types.js";

/** Confidence of an exact `wait_time_sources.location_id` link. */
export const REGISTRY_CONFIDENCE = 0.97;

/** Shared no-match block — the normal outcome, persisted for auditability
 *  (distinguishes "resolution ran, found nothing" from a legacy row). */
export const NO_MATCH: ResolvedLocation = {
  method: "no-match",
  confidence: 0,
};

/** Per-run cap on model-assisted disambiguation calls (budget guard). */
let jevCallsUsed = 0;
export function resetJevBudget(): void {
  jevCallsUsed = 0;
}
export function jevBudgetUsed(): number {
  return jevCallsUsed;
}

/** Everything the resolver needs about one observation. */
export interface ResolveInput {
  /** Only social + govt legs resolve; crowd reports carry structured ground
   *  truth already (captured address → geocoded Location). */
  domain: "social" | "govt" | "crowd";
  /** Social leg description set (caption + hashtags + vision descriptions). */
  description?: DescriptionSet | null;
  /** Govt leg: the source site's own point label ("Some Church (P-2)"). */
  rawLabel?: string | null;
  /** Govt leg: physical address from the REST fields, when present. */
  address?: string | null;
  /** Known scope (govt source config); overrides text derivation. */
  scopeHint?: LocationScope | null;
  /** Govt source URL — the registry join key. */
  sourceUrl?: string | null;
  /** Source reference (context key when author is absent). */
  sourceRef?: string | null;
  /** Author handle — the recent-context key. */
  author?: string | null;
  /** Config-side registry override (govt-sources.jsonl `location_id` mirror
   *  of wait_time_sources.location_id) — wins over the URL join. */
  registryLocationId?: number | string | null;
}

/** Fresh deps for one run — one PizzabaseApi instance (cache shared across
 *  a source's readings). Callers hold this for the run's lifetime. */
export function createResolveDeps(s: Settings = settings): ResolveDeps {
  const api = s.pizzabaseUrl
    ? new PizzabaseApi(s.pizzabaseUrl, s.pizzabaseKey)
    : undefined;
  return {
    registry: api,
    locations: api,
    context: new LocalBusContextProvider(),
    jev: s.jevResolveModel && s.openrouterKey ? jevResolveProvider : undefined,
    maxCandidates: s.resolveMaxCandidates,
  };
}

let defaultDeps: ResolveDeps | undefined;
function defaultResolveDeps(): ResolveDeps {
  if (!defaultDeps) defaultDeps = createResolveDeps();
  return defaultDeps;
}

/** Flatten the message text for scope derivation + the Jev disambiguation
 *  call: caption, hashtags (camelCase split — they carry place mentions),
 *  image/video descriptions, and (govt) the raw point label + address. The
 *  govt leg's "REST field evidence" caption is deliberately NOT included —
 *  it's evidence prose, not place text. */
export function flattenResolveText(input: ResolveInput): string {
  const parts: string[] = [];
  const d = input.description;
  if (d?.caption) parts.push(d.caption);
  for (const tag of d?.item.hashtags ?? []) parts.push(hashtagWords(tag));
  if (d?.imageDescriptions?.length) parts.push(d.imageDescriptions.join(". "));
  if (d?.videoSummary) parts.push(d.videoSummary);
  if (input.rawLabel) parts.push(input.rawLabel);
  if (input.address) parts.push(input.address);
  return parts.join(". ");
}

function dedupeMentions(mentions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mentions) {
    const key = m.toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

async function resolveInner(
  input: ResolveInput,
  deps: ResolveDeps,
): Promise<ResolvedLocation> {
  // Crowd leg: structured ground truth, out of scope (issue #35).
  if (input.domain !== "social" && input.domain !== "govt") return NO_MATCH;

  // 1) REGISTRY short-circuit (govt only): exact link wins, no fuzzy.
  if (input.domain === "govt" && deps.registry) {
    const registered =
      input.registryLocationId != null
        ? { location_id: input.registryLocationId }
        : input.sourceUrl
          ? await deps.registry.findBySourceUrl(input.sourceUrl)
          : null;
    if (registered) {
      const row = await deps.registry.getLocation(registered.location_id);
      // A registry hit with no usable row data isn't a link — fall through.
      if (row && (row.id != null || rowAddressOf(row)))
        return resolvedFromRow(row, "registry", REGISTRY_CONFIDENCE);
    }
  }

  // 2) SCOPE: hint → text → recent context.
  const text = flattenResolveText(input);
  const mentions = dedupeMentions([
    ...extractMentions({
      description: input.description,
      rawLabel: input.rawLabel,
      address: input.address,
    }),
    // raw label + address participate even when the extractor's
    // capitalization rules don't recognize them (lowercase site labels)
    ...(input.rawLabel ? [input.rawLabel] : []),
    ...(input.address ? [input.address] : []),
  ]);
  if (!mentions.length) return NO_MATCH;

  let scope: LocationScope | undefined = input.scopeHint ?? undefined;
  if (!scope?.state && !scope?.county) {
    const derived = deriveScope(text);
    if (derived.state || derived.county) scope = derived;
  }
  let recent: Observation[] = [];
  if (input.author && deps.context) {
    recent = await deps.context
      .recentObserved(input.author, CONTEXT_LIMIT)
      .catch(() => []);
  }
  if (!scope?.state && !scope?.county) {
    const cs = contextScope(recent);
    if (cs.state || cs.county) scope = cs;
  }
  if (!scope?.state && !scope?.county) return NO_MATCH;
  const finalScope: LocationScope = scope;

  // 3) FUZZY prefilter over scoped rows.
  const rows = deps.locations
    ? (
        await deps.locations
          .listLocations(finalScope, settings.resolveLocationsLimit)
          .catch(() => [] as LocationRow[])
      ).filter((r) => scopeMatchesRow(r, finalScope))
    : [];
  if (!rows.length) return NO_MATCH;
  const ranked = rankCandidates(mentions, rows, {
    limit: deps.maxCandidates ?? MAX_CANDIDATES,
  });
  if (!ranked.length) return NO_MATCH;

  // 4) Clear winner accepted deterministically — no model call.
  if (isClearWinner(ranked)) return resolvedFromScore(ranked[0]!, "fuzzy");

  // 5) CONTEXT tiebreak among the (near-)tied leaders.
  const cr = contextResolved(recent);
  if (cr) {
    const pick = applyContextTiebreak(ranked, cr);
    if (pick) return resolvedFromScore(pick, "fuzzy");
  }

  // 6) JEV disambiguation over the ≤25 candidates (budget-guarded). Any
  //    failure degrades to the deterministic pick — the classify composite's
  //    contract, mirrored.
  if (deps.jev && jevCallsUsed < settings.resolveJevMaxCalls) {
    jevCallsUsed++;
    const historyLine = cr?.name ? `\nRecent context: ${cr.name}` : "";
    try {
      const d = await deps.jev.pick(
        text + historyLine,
        ranked.map(toCandidate),
      );
      if (d.locationId != null) {
        const hit = ranked.find(
          (e) => String(rowId(e.row)) === String(d.locationId),
        );
        if (hit)
          return resolvedFromScore(hit, "jev", { confidence: d.confidence });
      }
      // Jev examined the candidates and said none — a clean no-match.
      return NO_MATCH;
    } catch (err) {
      console.warn(
        `[feedflag] jev-resolve failed (${String(err).slice(0, 100)}) — deterministic fallback`,
      );
    }
  }

  // 7) Deterministic fallback (no Jev, budget spent, or Jev error):
  //    conservative confidence on the top-ranked row.
  return resolvedFromScore(ranked[0]!, "fuzzy", { discount: 0.9 });
}

function rowAddressOf(row: LocationRow): string {
  return row.fullAddress ?? row.full_address ?? row.address ?? "";
}

/**
 * Resolve the place being discussed. NEVER throws, NEVER blocks ingestion:
 * any internal failure returns NO_MATCH (call sites may .catch(() =>
 * NO_MATCH) as belt-and-braces, which is a no-op in practice).
 */
export async function resolveLocation(
  input: ResolveInput,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<ResolvedLocation> {
  try {
    return await resolveInner(input, deps);
  } catch (err) {
    console.warn(
      `[feedflag] location resolve failed (non-fatal): ${String(err).slice(0, 120)}`,
    );
    return NO_MATCH;
  }
}
