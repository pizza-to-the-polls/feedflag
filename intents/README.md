# Intents — Triple Helix pillar 3

Every `intents/<module>.yml` is a **machine-readable, versioned contract** for one
module: what decision it serves, what it takes and returns, what happens when it
degrades, and what it costs. This is the organizational strand of David Kabii's
Triple Helix Data Framework, whose load-bearing claim is that the contract must be
**explicit, versioned, and enforced through tooling** — `scripts/test-intents.ts`
is that tooling. Everything feedflag guarantees used to live in prose
(`TECHNICAL_DESIGN.md` decisions D1–D7, README architecture, per-file docblocks);
intents make those guarantees checkable.

## The three pillars (code / tests / intents)

| Pillar | What it is | Triple Helix strand | Where it lives |
|---|---|---|---|
| **Code** | the running implementation of each contract | Artifacts | `src/`, `scripts/` |
| **Tests** | executable proof that the contract holds | Processes | `scripts/test-*.ts` |
| **Intents** | the declared contract itself | Organizational contract | `intents/*.yml` |

An intent change without a code change is a lie; a code change without an intent
bump is an unversioned contract break. The gate (`scripts/test-intents.ts`) keeps
the three strands consistent — it fails CI on missing, malformed, orphaned,
over-budget, or out-of-version-sync intents.

## The five decision layers

Each intent declares one layer of the Triple Helix Decision Intelligence Stack
(reliable data → intelligence → insight → recommendation → decision):

| Layer | Question | feedflag modules |
|---|---|---|
| `reliable-data` | Can we trust the inputs? | `ingest`, `normalize`, `govt` gates, `store` |
| `intelligence` | What is this, classified? | `describe`, `classify` |
| `insight` | Is this worth acting on? | `pipeline` (flag gate: `FLAG_CONFIDENCE` + `flagCategories`), `emit` |
| `recommendation` | What should a human do? | `notify` |
| `decision` | Did the human act? | volunteer response — `scripts/collect-reactions.ts`, `scripts/label.ts` (prose today; an intent lands when the code does) |

## Reading an intent

```yaml
id: feedflag.intent/classify@1   # feedflag.intent/<module>@<n> — bump n on any contract change
module: src/classify/            # the code this contract binds (must exist; gate-checked)
layer: intelligence              # one of the five layers above
decision: "..."                  # the question this module answers for the pipeline
consumer: "..."                  # who depends on this output (code + downstream surfaces)
contract:
  input: "..."                   # the shape handed in
  output: "..."                  # the shape handed out
  invariants:                    # non-empty, <= 200 chars each — promises the code must keep
    - "..."
  fallback: "..."                # exactly what happens on failure (swallow-and-continue counts)
  sla:
    latency_ms_p95: 1000         # the timeout budget the code enforces on the dominant path
    freshness: "n/a"             # or a real window (e.g. the govt freshness gate)
    cost_per_week_usd_max: 1     # from README's per-leg budget bands; the gate sums these
  pii: "..."                     # the PII floor for this module (D6: never contactInfo)
tests: scripts/test-*.ts         # the suite that encodes this intent (may not exist yet)
status: implemented              # planned | implemented | degraded
```

## When to bump `@n`

Increment the version suffix whenever the **contract** changes, not the code:

- input or output shape changes (fields added, removed, re-typed)
- an invariant is added, removed, or weakened
- fallback behaviour changes (e.g. a swallow becomes a retry)
- the SLA changes (timeout budget, freshness window, cost band)
- the PII floor changes

Do **not** bump for internal refactors, bug fixes, or comment edits that keep the
contract identical — those are covered by tests and review.

## Agent reading order

An agent (or a human at 2am during an election) reads `intents/` **before**
`src/`. The intent tells you what the module guarantees and what it costs; the
code is one implementation of that contract. If the code and the intent disagree,
the gate has already failed — fix whichever side is wrong, and bump `@n` if the
contract moved.

## Enforcement

`scripts/test-intents.ts` (part of `npm test`) enforces, with a non-zero exit:

1. bidirectional mapping — every `src/<dir>/` has an intent, every intent maps to
   real code (no orphans either way; `pipeline` and `extract-wait-times` map to
   their single files);
2. schema — every intent parses, has all keys, valid `layer`/`status`, and an id
   matching `feedflag.intent/<module>@<n>`;
3. invariants — every entry non-empty and ≤ 200 characters;
4. version sync — the `feedflag/observation@N` literal is identical across
   `src/types.ts`, `src/emit/records.ts`, `src/ingest/reports.ts` and
   `scripts/extract-wait-times.ts`, and every intent that names the schema names
   the same version (the version is read from source, never restated here);
5. budget — `Σ cost_per_week_usd_max` across all intents stays under the
   README's $350/wk ceiling; the gate prints the running total.
