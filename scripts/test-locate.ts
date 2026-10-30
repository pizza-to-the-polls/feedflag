/**
 * Regression tests for the location-resolution ladder (issue #49).
 *
 * PR #36 shipped src/locate/ — nine modules, ~1,270 lines that decide WHICH
 * polling place an observation is about — with zero tests, despite
 * src/locate/types.ts being a complete dependency-injection surface whose own
 * docblock promises "tests pin every resolution case with fixtures and no
 * network". This suite makes good on that promise: every case injects fakes
 * for the four providers (registry, locations, context, jev) over
 * `ResolveDeps`, so the whole ladder — registry join, scope constraint,
 * fuzzy prefilter, clear-winner short-circuit, recent-context tiebreak, Jev
 * disambiguation, no-match — is pinned with no network, no credentials, no
 * process.env mutation, and no writes anywhere.
 *
 * The single most load-bearing case is #3: two same-named `locations` rows in
 * different counties, where the scope filter must keep the cross-county twin
 * out of the candidate pool. A nationwide fuzzy match that can name the
 * wrong county's polling place is a correctness bug, not a tuning nit.
 *
 * All fixtures are synthetic (invented places, counties, example.invalid
 * URLs, no real text or handles). Run: npx tsx scripts/test-locate.ts —
 * main's scripts/test-*.ts glob discovery picks this suite up automatically
 * once #36 merges.
 */
import assert from "node:assert/strict";
import { settings } from "../src/config.js";
import { hasGovtEvidence } from "../src/govt/evidence.js";
import { MAX_CANDIDATES, SIMILARITY_THRESHOLD } from "../src/locate/fuzzy.js";
import { parseJevResolveResponse } from "../src/locate/jev.js";
import { PizzabaseApi } from "../src/locate/pizzabase-api.js";
import {
  NO_MATCH,
  REGISTRY_CONFIDENCE,
  jevBudgetUsed,
  resetJevBudget,
  resolveLocation,
  type ResolveInput,
} from "../src/locate/resolve.js";
import type {
  CandidateLocation,
  ContextProvider,
  LocationDecisionProvider,
  LocationProvider,
  LocationRow,
  LocationScope,
  RegisteredSource,
  RegistryProvider,
  ResolveDeps,
} from "../src/locate/types.js";
import {
  PLACE_SHOW_CONFIDENCE,
  flagPayload,
  placeLine,
  placeShowFloor,
} from "../src/notify/format.js";
import type {
  DescriptionSet,
  FeedItem,
  FlaggedItem,
  Observation,
  ResolvedLocation,
} from "../src/types.js";

console.log("locate resolution regression tests (issue #49)\n");

// ---------------------------------------------------------------------------
// Synthetic fixtures + recording fakes (all injected; nothing global touched)
// ---------------------------------------------------------------------------

let fixtureSeq = 0;

const SOURCE_URL = "https://example.invalid/locator/wait-times";
/** Scope hint shaped like a govt source's own config (state + county). */
const SCOPE_HINT: LocationScope = { state: "TX", county: "Fake" };

function makeFeedItem(caption: string, hashtags: string[] = []): FeedItem {
  fixtureSeq++;
  return {
    id: `synthetic-item-${fixtureSeq}`,
    platform: "x",
    authorHandle: "syntheticvoter01",
    postedAt: "2026-10-30T14:00:00Z",
    caption,
    hashtags,
    mediaUrls: [],
    source: "test:synthetic",
  };
}

function makeDescription(
  caption: string,
  hashtags: string[] = [],
): DescriptionSet {
  return {
    item: makeFeedItem(caption, hashtags),
    caption,
    imageDescriptions: [],
  };
}

function makeObservation(over: Partial<Observation> = {}): Observation {
  fixtureSeq++;
  return {
    schema: "feedflag/observation@1",
    domain: "social",
    source_ref: "test:synthetic-source",
    author: "syntheticvoter01",
    platform: "x",
    observed_at: "2026-10-30T14:00:00Z",
    signal_kind: "poll_line_report",
    confidence: 0.9,
    provider: "jev",
    relevant: true,
    description: makeDescription("synthetic test caption"),
    ...over,
  };
}

/** Registry fake: a map of source URL → registered location_id, plus the
 *  `locations` rows getLocation() can return. Can be made to fail. */
class FakeRegistry implements RegistryProvider {
  findBySourceUrlCalls = 0;
  getLocationCalls = 0;
  constructor(
    private links: Map<string, RegisteredSource> = new Map(),
    private rows: Map<string, LocationRow | null> = new Map(),
    private fail = false,
  ) {}

  async findBySourceUrl(url: string): Promise<RegisteredSource | null> {
    this.findBySourceUrlCalls++;
    if (this.fail) throw new Error("registry transport down");
    return this.links.get(url) ?? null;
  }

  async getLocation(id: number | string): Promise<LocationRow | null> {
    this.getLocationCalls++;
    if (this.fail) throw new Error("registry transport down");
    return this.rows.get(String(id)) ?? null;
  }
}

/** Locations fake: returns a fixed (scoped) row list and records every call
 *  (scope + limit) so tests can assert lookup and cap behavior. */
class FakeLocations implements LocationProvider {
  calls: { scope: LocationScope; limit: number }[] = [];
  constructor(private rows: LocationRow[] | Error) {}

  async listLocations(
    scope: LocationScope,
    limit: number,
  ): Promise<LocationRow[]> {
    this.calls.push({ scope, limit });
    if (this.rows instanceof Error) throw this.rows;
    return this.rows;
  }
}

/** Context fake: returns a fixed recent-observation history. */
class FakeContext implements ContextProvider {
  calls = 0;
  constructor(private obs: Observation[] | Error) {}

  async recentObserved(
    _author: string,
    _limit: number,
  ): Promise<Observation[]> {
    this.calls++;
    if (this.obs instanceof Error) throw this.obs;
    return this.obs;
  }
}

/** Jev fake: records pick() calls (text + candidate list) and returns a
 *  fixed typed decision — or throws, to simulate transport failure. */
class FakeJev implements LocationDecisionProvider {
  name = "fake-jev-resolve";
  pickCount = 0;
  lastText: string | undefined;
  lastCandidates: CandidateLocation[] | undefined;
  constructor(
    private result:
      { locationId: number | string | null; confidence: number } | Error,
  ) {}

  async pick(
    text: string,
    candidates: CandidateLocation[],
  ): Promise<{ locationId: number | string | null; confidence: number }> {
    this.pickCount++;
    this.lastText = text;
    this.lastCandidates = candidates;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

/** Two same-named in-county rows — the classic ambiguous tie (two sites
 *  sharing a name). Only recent context or Jev can tell them apart. */
function twinRows(idA: number, idB: number): LocationRow[] {
  return [
    {
      id: idA,
      name: "Mockingbird Community Center",
      address: "100 Mockingbird Ln",
      county: "Fake",
      state: "TX",
    },
    {
      id: idB,
      name: "Mockingbird Community Center",
      address: "300 Mockingbird Ln",
      county: "Fake",
      state: "TX",
    },
  ];
}

/** A social-leg input whose caption names the twin sites, with county/state
 *  carried only by the hashtags (scope must be derived from the text). */
function socialMentionInput(author: string | null): ResolveInput {
  const caption = "Long line at Mockingbird Community Center";
  return {
    domain: "social",
    description: makeDescription(caption, ["#FakeCounty", "#TX"]),
    author,
  };
}

/** A social-leg input mentioning the 30-way ambiguous pool (case 7). */
function ambiguityInput(author: string | null): ResolveInput {
  const caption = "Long line at Ambiguity Community Center";
  return {
    domain: "social",
    description: makeDescription(caption, ["#FakeCounty", "#TX"]),
    author,
  };
}

function deps(over: ResolveDeps): ResolveDeps {
  return over;
}

// ---------------------------------------------------------------------------
// Case 1 — Registry link wins (govt): the exact wait_time_sources.location_id
// join beats every fuzzy signal, even when the raw point label looks nothing
// like the row's name, and neither the fuzzy chain nor Jev is consulted.
// ---------------------------------------------------------------------------
{
  const registry = new FakeRegistry(
    new Map<string, RegisteredSource>([
      [SOURCE_URL, { location_id: 1, url: SOURCE_URL }],
    ]),
    new Map<string, LocationRow | null>([
      [
        "1",
        {
          id: 1,
          name: "Fakeville Community Church",
          address: "123 Main St",
          canonical_id: "C1",
        },
      ],
    ]),
  );
  const locations = new FakeLocations([]);
  const jev = new FakeJev({ locationId: 99, confidence: 0.9 });

  const result = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "Some Church (P-2)", // deliberately unlike the row name
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({ registry, locations, jev }),
  );

  assert.equal(result.method, "registry");
  assert.equal(result.confidence, REGISTRY_CONFIDENCE);
  assert.equal(result.confidence, 0.97);
  assert.equal(result.location_id, 1);
  assert.equal(result.canonical_id, "C1");
  assert.equal(result.address, "123 Main St");
  assert.equal(result.name, "Fakeville Community Church");
  // The whole downstream chain was never consulted.
  assert.equal(registry.getLocationCalls, 1);
  assert.equal(
    locations.calls.length,
    0,
    "locations never consulted on a registry hit",
  );
  assert.equal(jev.pickCount, 0, "Jev never called on a registry hit");

  // Config-side override (govt-sources.jsonl location_id mirror) wins
  // without even the URL join.
  const overrideRegistry = new FakeRegistry(
    new Map<string, RegisteredSource>(), // the URL join must never fire
    new Map<string, LocationRow | null>([
      [
        "5",
        {
          id: 5,
          name: "Override Precinct",
          address: "5 Override Way",
          canonical_id: "C5",
        },
      ],
    ]),
  );

  const result2 = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "Some Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
      registryLocationId: 5,
    },
    deps({ registry: overrideRegistry, locations, jev }),
  );

  assert.equal(result2.method, "registry");
  assert.equal(result2.location_id, 5);
  assert.equal(
    overrideRegistry.findBySourceUrlCalls,
    0,
    "registryLocationId override skips the URL join entirely",
  );

  console.log(
    "  ✓ registry link wins: exact join at 0.97, fuzzy chain + Jev untouched",
  );
}

// ---------------------------------------------------------------------------
// Case 2 — A registry hit with an unusable row is NOT a link: resolution
// must fall through to the fuzzy chain instead of emitting a hollow registry
// block (getLocation → null, or a row with no id and no address).
// ---------------------------------------------------------------------------
{
  const locations = new FakeLocations([
    {
      id: 10,
      name: "St. Synthetic Church",
      address: "100 Church St",
      county: "Fake",
      state: "TX",
    },
  ]);
  const jev = new FakeJev({ locationId: 99, confidence: 0.9 });

  // (a) getLocation resolves to null.
  const nullRegistry = new FakeRegistry(
    new Map<string, RegisteredSource>([[SOURCE_URL, { location_id: 1 }]]),
    new Map<string, LocationRow | null>([["1", null]]),
  );
  const r1 = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "St. Synthetic Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({ registry: nullRegistry, locations, jev }),
  );
  assert.equal(r1.method, "fuzzy", "null registry row falls through to fuzzy");
  assert.equal(r1.location_id, 10);
  assert.equal(jev.pickCount, 0, "single candidate needs no model call");

  // (b) getLocation returns a row with no id and no address — no usable
  // data, so the registry "hit" must not resolve.
  const hollowRegistry = new FakeRegistry(
    new Map<string, RegisteredSource>([[SOURCE_URL, { location_id: 1 }]]),
    new Map<string, LocationRow | null>([["1", {}]]),
  );
  const r2 = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "St. Synthetic Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({ registry: hollowRegistry, locations, jev }),
  );
  assert.equal(r2.method, "fuzzy", "hollow registry row falls through");
  assert.equal(r2.location_id, 10);
  assert.notEqual(r2.method, "registry");

  console.log("  ✓ unusable registry row falls through to the fuzzy chain");
}

// ---------------------------------------------------------------------------
// Case 3 — THE critical case: cross-county twin rejection. Two same-named
// rows, one per county; only the in-county row may be picked. Mutation
// check: if scopeMatchesRow ignores county, both twins rank with a 0 gap →
// not a clear winner → Jev gets called → the pickCount assertion fails.
// ---------------------------------------------------------------------------
{
  const registry = new FakeRegistry(); // unenrolled source: no links
  const locations = new FakeLocations([
    {
      id: 1,
      name: "St. Synthetic Church",
      address: "100 Church St",
      county: "Fake",
      state: "TX",
    },
    {
      id: 2,
      name: "St. Synthetic Church",
      address: "200 Other Blvd",
      county: "Other",
      state: "TX",
    },
  ]);
  const context = new FakeContext([]);
  const jev = new FakeJev({ locationId: 2, confidence: 0.9 }); // the twin
  resetJevBudget();

  const result = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "St. Synthetic Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({ registry, locations, context, jev }),
  );

  assert.equal(result.method, "fuzzy");
  // confidenceFromScore(1.0): a perfect in-county match, above the Slack
  // accept threshold (resolveSlackMinConfidence default 0.8).
  assert.equal(result.confidence, 0.95);
  assert.equal(result.location_id, 1, "the Fake-county twin wins");
  assert.equal(result.address, "100 Church St");
  assert.equal(jev.pickCount, 0, "scope filter resolves it — no model call");
  assert.deepEqual(locations.calls[0]?.scope, { state: "TX", county: "Fake" });

  console.log("  ✓ cross-county twin rejected: only the in-county row wins");
}

// ---------------------------------------------------------------------------
// Case 4 — Clear winner short-circuits the model: one candidate scoring
// decisively over the runner-up resolves deterministically (method fuzzy)
// with zero Jev calls. Mutation check: making isClearWinner always false
// sends the same fixture to Jev → the pickCount assertion fails.
// ---------------------------------------------------------------------------
{
  const locations = new FakeLocations([
    {
      id: 10,
      name: "Oakwood Community Center",
      address: "500 Oak Ave",
      county: "Fake",
      state: "TX",
    },
    {
      id: 11,
      name: "Oakwood Elementary School",
      address: "600 Oak Ave",
      county: "Fake",
      state: "TX",
    },
  ]);
  const jev = new FakeJev({ locationId: 11, confidence: 0.9 });
  resetJevBudget();

  const result = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "Oakwood Community Center",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({ registry: new FakeRegistry(), locations, jev }),
  );

  assert.equal(result.method, "fuzzy");
  assert.equal(result.location_id, 10);
  assert.equal(jev.pickCount, 0, "a decisive winner never costs a model call");

  console.log("  ✓ clear winner short-circuits: fuzzy accept, Jev zero calls");
}

// ---------------------------------------------------------------------------
// Case 5 — Caption-only mention disambiguated by recent context: two
// near-tied candidates, no scope hint (scope derived from the text's
// hashtags), and the author's history naming one of them. The context twin
// wins — deterministically, still method "fuzzy", still no model call.
// ---------------------------------------------------------------------------
{
  const contextObs = makeObservation({
    domain: "social",
    author: "syntheticvoter01",
    location: {
      resolved: {
        method: "fuzzy",
        confidence: 0.9,
        location_id: 21,
        name: "Mockingbird Community Center",
      },
    },
  });
  const locations = new FakeLocations(twinRows(20, 21));
  const context = new FakeContext([contextObs]);
  const jev = new FakeJev({ locationId: 20, confidence: 0.9 });
  resetJevBudget();

  const result = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({ registry: new FakeRegistry(), locations, context, jev }),
  );

  assert.equal(result.method, "fuzzy", "context tiebreak is still fuzzy");
  assert.equal(result.location_id, 21, "the author's recent place wins");
  assert.equal(jev.pickCount, 0, "a context-broken tie needs no model call");
  assert.equal(context.calls, 1, "recent context was consulted");
  assert.deepEqual(locations.calls[0]?.scope, { state: "TX", county: "Fake" });

  console.log("  ✓ caption-only mention resolved by the author's history");
}

// ---------------------------------------------------------------------------
// Case 6 — Ambiguous → Jev picks: near-tied candidates with no context
// signal reach the injected Jev fake, which sees the candidate list and the
// flattened text; its typed pick is returned as method "jev" with its own
// confidence. When history exists but names a non-candidate, the model still
// sees the "Recent context:" line.
// ---------------------------------------------------------------------------
{
  // (a) No context at all — the tie reaches the model.
  const locations = new FakeLocations(twinRows(20, 21));
  const context = new FakeContext([]);
  const jev = new FakeJev({ locationId: 20, confidence: 0.85 });
  resetJevBudget();

  const result = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({ registry: new FakeRegistry(), locations, context, jev }),
  );

  assert.equal(result.method, "jev");
  assert.equal(result.location_id, 20);
  assert.equal(result.confidence, 0.85, "Jev's own confidence passes through");
  assert.equal(jev.pickCount, 1);
  assert.equal(jev.lastCandidates?.length, 2, "the model saw the full set");
  assert.ok(
    (jev.lastCandidates ?? []).every((c) => c.name && c.address),
    "candidates carry name + address",
  );
  assert.match(jev.lastText ?? "", /Mockingbird Community Center/);
  assert.match(jev.lastText ?? "", /Fake County/);
  assert.equal(
    jev.lastText?.includes("Recent context:"),
    false,
    "no context line when history is empty",
  );

  // (b) Context exists but names a non-candidate → the tiebreak dead-ends,
  // Jev still decides, and the model sees the Recent context line.
  const otherContext = makeObservation({
    domain: "social",
    location: {
      resolved: {
        method: "jev",
        confidence: 0.8,
        location_id: 99,
        name: "Some Other Place",
      },
    },
  });
  const locations2 = new FakeLocations(twinRows(20, 21));
  const context2 = new FakeContext([otherContext]);
  const jev2 = new FakeJev({ locationId: 21, confidence: 0.7 });
  resetJevBudget();

  const result2 = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations: locations2,
      context: context2,
      jev: jev2,
    }),
  );

  assert.equal(result2.method, "jev");
  assert.equal(result2.location_id, 21);
  assert.equal(jev2.pickCount, 1);
  assert.match(
    jev2.lastText ?? "",
    /Recent context: Some Other Place/,
    "the model saw the Recent context line",
  );

  console.log(
    "  ✓ ambiguous → Jev picks: typed decision, own confidence, context line",
  );
}

// ---------------------------------------------------------------------------
// Case 7 — maxCandidates is Jev's choice-cardinality guard: with 30 tied
// rows and a cap of 10, Jev sees at most 10 candidates. The DB lookup limit
// is a separate budget (settings.resolveLocationsLimit); the cap is applied
// at ranking time. Default cap is 25 (MAX_CANDIDATES).
// ---------------------------------------------------------------------------
{
  const rows: LocationRow[] = [];
  for (let i = 1; i <= 30; i++) {
    rows.push({
      id: 100 + i,
      name: "Ambiguity Community Center",
      address: `${i} Ambiguity Blvd`,
      county: "Fake",
      state: "TX",
    });
  }

  // Explicit cap of 10 — the 30-way tie reaches the model.
  const locations = new FakeLocations(rows);
  const jev = new FakeJev({ locationId: 101, confidence: 0.8 });
  resetJevBudget();
  const result = await resolveLocation(
    ambiguityInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations,
      context: new FakeContext([]),
      jev,
      maxCandidates: 10,
    }),
  );

  assert.equal(result.method, "jev", "a 10-way tie reaches the model");
  assert.equal(jev.lastCandidates?.length, 10, "Jev saw exactly the cap");
  assert.ok((jev.lastCandidates ?? []).length <= 10);
  assert.equal(
    locations.calls[0]?.limit,
    settings.resolveLocationsLimit,
    "DB fetch limit is the settings budget; the cap applies at ranking",
  );

  // Default cap: no maxCandidates injected → MAX_CANDIDATES (25).
  const locations2 = new FakeLocations(rows);
  const jev2 = new FakeJev({ locationId: 101, confidence: 0.8 });
  resetJevBudget();
  const result2 = await resolveLocation(
    ambiguityInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations: locations2,
      context: new FakeContext([]),
      jev: jev2,
    }),
  );

  assert.equal(result2.method, "jev");
  assert.equal(jev2.lastCandidates?.length, MAX_CANDIDATES);
  assert.ok(
    (jev2.lastCandidates ?? []).length <= MAX_CANDIDATES,
    "default cap 25 holds",
  );

  console.log(
    "  ✓ maxCandidates cap: Jev never sees more choices than allowed",
  );
}

// ---------------------------------------------------------------------------
// Case 8 — No candidate → NO_MATCH: the shared { method: "no-match",
// confidence: 0 } block, the govt raw label preserved verbatim next to it,
// and ingestion unblocked (resolution returns normally, never throws).
// ---------------------------------------------------------------------------
{
  const locations = new FakeLocations([]); // empty pool
  const result = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "Some Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({
      registry: new FakeRegistry(),
      locations,
      jev: new FakeJev({ locationId: 1, confidence: 1 }),
    }),
  );

  assert.deepEqual(result, { method: "no-match", confidence: 0 });
  assert.equal(result.method, "no-match");
  assert.equal(result.confidence, 0);

  // The observation's raw label survives an additive resolved block.
  const obs = makeObservation({
    domain: "govt",
    location: { raw: "Some Church (P-2)", state: "TX", county: "Fake" },
  });
  obs.location!.resolved = result;
  assert.equal(
    obs.location!.raw,
    "Some Church (P-2)",
    "raw label preserved verbatim after resolution",
  );

  // Other normal no-match outcomes: the crowd leg is out of scope, and a
  // govt input with no place text has nothing to match on.
  const crowd = await resolveLocation({ domain: "crowd" }, deps({}));
  assert.deepEqual(crowd, NO_MATCH);
  const noText = await resolveLocation(
    { domain: "govt", scopeHint: SCOPE_HINT },
    deps({ registry: new FakeRegistry(), locations }),
  );
  assert.deepEqual(noText, NO_MATCH);

  console.log("  ✓ no candidate → no-match: confidence 0, raw label verbatim");
}

// ---------------------------------------------------------------------------
// Case 9 — Jev failure degrades deterministically: a transport-throwing fake
// falls back to the deterministic pick (discounted fuzzy); a fake returning
// a non-candidate id yields a clean no-match. Neither may ever throw out of
// resolveLocation (the classify composite's contract, mirrored).
// ---------------------------------------------------------------------------
{
  // (a) Transport failure — pick throws.
  const locations = new FakeLocations(twinRows(20, 21));
  const throwingJev = new FakeJev(new Error("transport timeout"));
  resetJevBudget();
  const r1 = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations,
      context: new FakeContext([]),
      jev: throwingJev,
    }),
  );

  assert.equal(r1.method, "fuzzy", "transport failure degrades to fuzzy");
  assert.equal(r1.location_id, 20, "the fallback keeps the top-ranked row");
  assert.ok(
    r1.confidence > 0 && r1.confidence < 0.95,
    "fallback confidence is discounted",
  );

  // (b) Invalid decision — at the orchestrator seam this manifests as a
  // pick outside the candidate set (the parse layer's own contract is
  // pinned directly in case 10).
  const locations2 = new FakeLocations(twinRows(20, 21));
  const nonsenseJev = new FakeJev({ locationId: 9999, confidence: 0.9 });
  resetJevBudget();
  const r2 = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations: locations2,
      context: new FakeContext([]),
      jev: nonsenseJev,
    }),
  );

  assert.deepEqual(
    r2,
    NO_MATCH,
    "a non-candidate pick is a clean no-match, not a throw",
  );

  console.log(
    "  ✓ Jev failure degrades: transport throw → fuzzy pick; bad pick → no-match",
  );
}

// ---------------------------------------------------------------------------
// Case 10 — parseJevResolveResponse contract (pure function): an id outside
// the candidate set throws (contract violation — the deterministic fallback
// takes over); location_id null is a legal answer; confidence is clamped to
// 0..1 and a non-finite confidence becomes 0. Mutation check: removing the
// out-of-set throw fails the first assertion.
// ---------------------------------------------------------------------------
{
  const cands: CandidateLocation[] = [
    {
      location_id: "1",
      name: "St. Synthetic Church",
      address: "100 Church St",
    },
  ];

  // Out-of-set id → contract violation.
  const outOfSet = '{"location_id": 999, "confidence": 0.5}';
  assert.throws(
    () => parseJevResolveResponse(outOfSet, cands),
    /non-candidate id 999/,
  );

  // null is a legal answer ("none of these").
  const nullPick = parseJevResolveResponse(
    '{"location_id": null, "confidence": 0.3}',
    cands,
  );
  assert.deepEqual(nullPick, { locationId: null, confidence: 0.3 });

  // In-set ids pass through, preserving the wire type.
  const strPick = parseJevResolveResponse(
    '{"location_id": "1", "confidence": 0.8}',
    cands,
  );
  assert.deepEqual(strPick, { locationId: "1", confidence: 0.8 });

  const numPick = parseJevResolveResponse(
    '{"location_id": 1, "confidence": 0.8}',
    cands,
  );
  assert.deepEqual(numPick, { locationId: 1, confidence: 0.8 });

  // Confidence clamped to 0..1.
  const overConf = parseJevResolveResponse(
    '{"location_id": "1", "confidence": 1.5}',
    cands,
  );
  assert.equal(overConf.confidence, 1, "clamped up to 1");

  const underConf = parseJevResolveResponse(
    '{"location_id": "1", "confidence": -0.5}',
    cands,
  );
  assert.equal(underConf.confidence, 0, "clamped down to 0");

  // Non-finite (or absent) confidence becomes 0.
  const badConf = parseJevResolveResponse(
    '{"location_id": "1", "confidence": "abc"}',
    cands,
  );
  assert.equal(badConf.confidence, 0, "non-numeric confidence becomes 0");

  const noConf = parseJevResolveResponse('{"location_id": "1"}', cands);
  assert.equal(noConf.confidence, 0, "missing confidence becomes 0");

  // Unparseable body → throws (the orchestrator catches and degrades).
  assert.throws(
    () => parseJevResolveResponse("the model said no", cands),
    /unparseable jev-resolve/,
  );

  console.log(
    "  ✓ parseJevResolveResponse: out-of-set throws, null legal, confidence clamped",
  );
}

// ---------------------------------------------------------------------------
// Case 11 — Provider failure is non-fatal: rejecting registry / locations /
// context providers degrade to [] or NO_MATCH. resolveLocation never throws
// (its failures can only cost the resolved block, never the observation).
// ---------------------------------------------------------------------------
{
  // Registry lookup rejects (govt leg) → the outer guard returns NO_MATCH.
  const badRegistry = new FakeRegistry(undefined, undefined, true);
  const r1 = await resolveLocation(
    {
      domain: "govt",
      rawLabel: "St. Synthetic Church (P-2)",
      scopeHint: SCOPE_HINT,
      sourceUrl: SOURCE_URL,
    },
    deps({
      registry: badRegistry,
      locations: new FakeLocations([]),
      jev: new FakeJev({ locationId: 1, confidence: 1 }),
    }),
  );
  assert.deepEqual(r1, NO_MATCH, "a rejecting registry degrades to no-match");

  // locations.listLocations rejects → the .catch(() => []) path yields an
  // empty pool → NO_MATCH.
  const r2 = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations: new FakeLocations(new Error("db timeout")),
      context: new FakeContext([]),
      jev: new FakeJev({ locationId: 1, confidence: 1 }),
    }),
  );
  assert.deepEqual(r2, NO_MATCH, "a rejecting locations provider degrades");

  // recentObserved rejects → caught to [] → resolution continues (here it
  // still reaches Jev over the tied candidates).
  const jev = new FakeJev({ locationId: 20, confidence: 0.8 });
  resetJevBudget();
  const r3 = await resolveLocation(
    socialMentionInput("syntheticvoter01"),
    deps({
      registry: new FakeRegistry(),
      locations: new FakeLocations(twinRows(20, 21)),
      context: new FakeContext(new Error("bus read failed")),
      jev,
    }),
  );
  assert.equal(r3.method, "jev", "a rejecting context provider never blocks");

  console.log("  ✓ provider failures non-fatal: rejects degrade, never throw");
}

// ---------------------------------------------------------------------------
// Case 12 — Jev budget guard: per-run cap on model-assisted calls. The cap
// is read from `settings.resolveJevMaxCalls` at call time and has no DI seam
// yet, so this test mutates the settings OBJECT (never process.env) and
// restores it in a finally. Calls stop at the cap and resolution degrades to
// the deterministic pick rather than throwing.
// ---------------------------------------------------------------------------
{
  const originalMax = settings.resolveJevMaxCalls;
  try {
    settings.resolveJevMaxCalls = 2;
    resetJevBudget();
    assert.equal(jevBudgetUsed(), 0, "budget starts at zero after reset");

    const jev = new FakeJev({ locationId: 20, confidence: 0.8 });
    const shared = deps({
      registry: new FakeRegistry(),
      locations: new FakeLocations(twinRows(20, 21)),
      context: new FakeContext([]),
      jev,
    });

    // First two ambiguous resolves consume the budget.
    const r1 = await resolveLocation(
      socialMentionInput("syntheticvoter01"),
      shared,
    );
    assert.equal(r1.method, "jev");
    assert.equal(jevBudgetUsed(), 1, "budget increments per model call");
    const r2 = await resolveLocation(
      socialMentionInput("syntheticvoter01"),
      shared,
    );
    assert.equal(r2.method, "jev");
    assert.equal(jevBudgetUsed(), 2, "budget increments per model call");

    // Third resolve: budget spent → deterministic fuzzy fallback, no throw.
    const r3 = await resolveLocation(
      socialMentionInput("syntheticvoter01"),
      shared,
    );
    assert.equal(r3.method, "fuzzy", "spent budget degrades to fuzzy");
    assert.equal(r3.location_id, 20);
    assert.ok(
      r3.confidence > 0 && r3.confidence < 0.95,
      "fallback confidence is discounted",
    );
    assert.equal(jev.pickCount, 2, "no call past the cap");
    assert.equal(jevBudgetUsed(), 2, "budget counter stops at the cap");
  } finally {
    settings.resolveJevMaxCalls = originalMax;
  }

  console.log("  ✓ Jev budget guard: stops at the cap, degrades cleanly");
}

// ---------------------------------------------------------------------------
// Case 13 — Read-only against pizzabase: PizzabaseApi is documented
// "Strictly GET". Every request the client makes must use the GET method —
// the pipeline writes only its own observation rows via the emit path.
// ---------------------------------------------------------------------------
{
  const calls: { url: string; method: string }[] = [];
  const realFetch = globalThis.fetch;
  // Fake fetch records the method and answers with an empty list — no real
  // network, no credentials (the key is a dummy).
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return { ok: true, json: async () => [] } as unknown as Response;
  }) as typeof fetch;

  try {
    const api = new PizzabaseApi(
      "https://example.invalid/pizzabase",
      "dummy-key",
    );
    await api.findBySourceUrl(SOURCE_URL);
    await api.getLocation(7);
    await api.listLocations({ state: "TX", county: "Fake" }, 25);

    assert.ok(calls.length >= 3, "all three lookups issued requests");
    for (const c of calls) {
      assert.equal(c.method, "GET", `pizzabase request must be GET: ${c.url}`);
      assert.match(c.url, /^https:\/\/example\.invalid\/pizzabase/);
    }
    assert.ok(
      calls.some((c) => c.url.includes("/wait-time-sources")),
      "registry join hits wait_time_sources",
    );
    assert.ok(
      calls.some((c) => c.url.includes("/locations")),
      "locations lookup hits /locations",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("  ✓ read-only pizzabase: every request is a GET");
}

// ---------------------------------------------------------------------------
// Case 14 — Regression, both legs: resolution is additive only. A resolved
// govt row still satisfies hasGovtEvidence (the evidence guard is unchanged)
// and a resolved social row keeps its classification untouched.
// ---------------------------------------------------------------------------
{
  // Govt leg: the evidence block survives the resolved block being added.
  const govtObs = makeObservation({
    domain: "govt",
    description: {
      ...makeDescription(""),
      evidence: { method: "rest", rawWaitTime: 42 },
    },
    location: { raw: "Some Church (P-2)", state: "TX", county: "Fake" },
  });
  assert.equal(hasGovtEvidence(govtObs.description), true);
  govtObs.location!.resolved = {
    method: "registry",
    confidence: 0.97,
    location_id: 1,
    name: "Fakeville Community Church",
    address: "123 Main St",
  };
  assert.equal(
    hasGovtEvidence(govtObs.description),
    true,
    "resolution must not strip the govt evidence block",
  );
  // Control: an evidenceless description still fails the guard.
  assert.equal(hasGovtEvidence(makeDescription("no evidence")), false);

  // Social leg: classification is untouched by the additive resolved block.
  const caption = "Long line at Mockingbird Community Center";
  const flag: FlaggedItem = {
    item: makeFeedItem(caption),
    description: makeDescription(caption),
    classification: {
      relevant: true,
      confidence: 0.91,
      category: "poll_line_report",
      provider: "jev",
    },
  };
  flag.resolvedLocation = {
    method: "fuzzy",
    confidence: 0.93,
    location_id: 20,
    name: "Mockingbird Community Center",
    address: "100 Mockingbird Ln",
  };
  assert.equal(flag.classification.relevant, true, "relevant unchanged");
  assert.equal(flag.classification.confidence, 0.91, "confidence unchanged");

  // Both blocks survive a JSON round-trip (the observation bus row shape).
  const roundTrip = JSON.parse(JSON.stringify(flag)) as FlaggedItem;
  assert.deepEqual(roundTrip.resolvedLocation, flag.resolvedLocation);
  assert.equal(roundTrip.classification.confidence, 0.91);
  assert.equal(roundTrip.classification.relevant, true);

  console.log(
    "  ✓ additive regression: govt evidence + social classification untouched",
  );
}

// ---------------------------------------------------------------------------
// The notify gate — what volunteers actually see
//
// `settings.resolveSlackMinConfidence` (RESOLVE_SLACK_MIN_CONFIDENCE, default
// 0.8) was declared in src/config.ts with the comment "below this
// resolved-confidence the Slack flag omits the `place:` line" and was read
// NOWHERE in src/: the only live gate was format.ts's own hardcoded
// PLACE_SHOW_CONFIDENCE (0.6), and `flagPayload().resolved_place` — the field
// Zapier maps into Slack steps — carried no gate at all. Because
// `confidenceFromScore` maps the 0.85 similarity threshold to exactly 0.6, the
// weakest fuzzy match that can exist was reaching the volunteer feed, and a
// low-confidence pick could surface through the payload even after the text
// suppressed it. These cases pin the wiring: ONE floor, applied to BOTH
// surfaces, with the hardcoded constant as an absolute minimum.
// ---------------------------------------------------------------------------
{
  const CAPTION = "Long line at Mockingbird Community Center";
  const flaggedWith = (r: ResolvedLocation | undefined): FlaggedItem => ({
    item: makeFeedItem(CAPTION),
    description: makeDescription(CAPTION),
    classification: {
      relevant: true,
      confidence: 0.91,
      category: "poll_line_report",
      provider: "synthetic-provider",
    },
    resolvedLocation: r,
  });
  const resolved = (
    confidence: number,
    method: ResolvedLocation["method"] = "fuzzy",
  ): ResolvedLocation => ({
    method,
    confidence,
    location_id: 30,
    name: "Mockingbird Community Center",
    address: "456 Mockingbird Ln",
  });

  // The configured knob is live and sets the effective floor.
  assert.equal(settings.resolveSlackMinConfidence, 0.8, "documented default");
  assert.equal(placeShowFloor(), 0.8, "the setting drives the floor");

  // A bare-threshold fuzzy match (confidenceFromScore(0.85) === 0.6) and
  // anything below the configured floor are suppressed on BOTH surfaces.
  for (const conf of [0.6, 0.7, 0.79]) {
    assert.equal(placeLine(flaggedWith(resolved(conf))), "", `text @${conf}`);
    assert.equal(
      flagPayload(flaggedWith(resolved(conf))).resolved_place,
      "",
      `payload @${conf} — must not bypass the text gate`,
    );
  }

  // At or above the floor it shows, naming the method, on both surfaces.
  assert.equal(
    placeLine(flaggedWith(resolved(0.8))),
    "place: 456 Mockingbird Ln (fuzzy match)",
  );
  assert.equal(
    flagPayload(flaggedWith(resolved(0.8))).resolved_place,
    "456 Mockingbird Ln",
  );
  assert.equal(
    placeLine(flaggedWith(resolved(0.97, "registry"))),
    "place: 456 Mockingbird Ln (registry match)",
  );

  // Diagnostics stay ungated: suppressing them would erase the audit trail of
  // a resolution that ran and was deliberately not shown.
  const shy = flagPayload(flaggedWith(resolved(0.6)));
  assert.equal(shy.resolved_place_method, "fuzzy");
  assert.equal(shy.resolved_place_confidence, 0.6);

  // no-match and absent never show, however the floor is set.
  assert.equal(placeLine(flaggedWith(NO_MATCH)), "");
  assert.equal(placeLine(flaggedWith(undefined)), "");
  assert.equal(flagPayload(flaggedWith(NO_MATCH)).resolved_place, "");

  // `settings` is a plain mutable object, so the floor can be exercised
  // without touching process.env; restored in the finally either way.
  const saved = settings.resolveSlackMinConfidence;
  try {
    settings.resolveSlackMinConfidence = 0.2;
    assert.equal(
      placeShowFloor(),
      PLACE_SHOW_CONFIDENCE,
      "the hard floor is authoritative when the setting goes below it",
    );
    assert.equal(placeLine(flaggedWith(resolved(0.5))), "", "0.5 < 0.6 floor");
    assert.equal(
      placeLine(flaggedWith(resolved(0.6))),
      "place: 456 Mockingbird Ln (fuzzy match)",
      "0.6 is exactly on the hard floor",
    );
    settings.resolveSlackMinConfidence = 0.95;
    assert.equal(
      placeShowFloor(),
      0.95,
      "raising the setting raises the floor",
    );
    assert.equal(placeLine(flaggedWith(resolved(0.9))), "");
    assert.equal(
      placeLine(flaggedWith(resolved(0.97, "registry"))),
      "place: 456 Mockingbird Ln (registry match)",
    );
  } finally {
    settings.resolveSlackMinConfidence = saved;
  }
  assert.equal(settings.resolveSlackMinConfidence, saved, "setting restored");

  console.log(
    "  ✓ notify gate: one floor, applied to the text line AND the payload field",
  );
}

// Threshold constants stay pinned to their documented values — the ladder's
// accept/dispatch semantics depend on them.
assert.ok(SIMILARITY_THRESHOLD === 0.85);
assert.ok(REGISTRY_CONFIDENCE === 0.97);
assert.ok(PLACE_SHOW_CONFIDENCE === 0.6);

console.log("\nAll locate resolution regression tests passed.");
