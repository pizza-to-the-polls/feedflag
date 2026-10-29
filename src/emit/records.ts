import type { FlaggedItem, Observation } from "../types.js";
import { NO_MATCH } from "../locate/resolve.js";

/**
 * FlaggedItem -> normalized, aggregator-ready Observation record.
 *
 * Shaped to load into pizzabase `wait_time_readings`
 * (GOVT_WAIT_TIME_SOURCES_PLAN.md §5): `source_type='social'`, `confidence`
 * per reading, `raw_json` = the description set. Schema-versioned so the
 * nationwide aggregator can evolve this without breaking old lines.
 *
 * `location.resolved` is filled by the location-resolution step
 * (src/locate/resolve.ts, issue #35) between classification and emit;
 * `wait_minutes` / `wait_category` remain a Phase-3-style extractor's job —
 * the social leg only classifies today. Jev cannot generate strings, so any
 * string extraction stays LLM-side (JEV_EXPLORATION.md).
 */
export function toObservation(f: FlaggedItem): Observation {
  return {
    schema: "feedflag/observation@1",
    domain: "social",
    source_ref: f.item.source,
    url: f.item.url,
    author: f.item.authorHandle,
    platform: f.item.platform,
    observed_at: new Date().toISOString(),
    posted_at: f.item.postedAt,
    // Issue #35 (additive): the resolved place rides in `location.resolved`;
    // no-match is persisted for auditability. Social rows previously had no
    // location block at all.
    location: {
      resolved: f.resolvedLocation ?? NO_MATCH,
    },
    signal_kind: f.classification.category,
    confidence: f.classification.confidence,
    provider: f.classification.provider,
    relevant: f.classification.relevant,
    description: f.description,
  };
}
