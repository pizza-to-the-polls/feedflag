/**
 * REST response-body unwrapping for govt wait-time sources.
 *
 * Incident: 2026-10-30 the Tarrant County GIS wait-time app
 * (gisit.tarrantcounty.com/tcvotingwaittime) returned to extraction as an
 * `api`-type source with no `rest` block — every run logged "0 readings
 * (REST empty — cycle not loaded or nothing reporting)" and carried the
 * Oct-24 screenshot-era state forward while the county's own app rendered
 * live data. The backend was there all along: an ASP.NET page method
 * (Home/GetWaitTimes, form-encoded ElectionCode) — but the body is
 * DOUBLE-ENCODED: a JSON *string* wrapping the real object
 * (`"{\"ElectionLocations\":[…]}"`), so `res.json()` yields a string, the
 * recordsPath traversal on `Record<string, unknown>` finds nothing, and the
 * run degrades to empty. The county's own client does `JSON.parse(raw)` on
 * exactly this body (tcvotingwaittime/js/shared.js CallWebMethod) — this
 * module replicates that unwrap upstream so a rest-configured source can
 * never silently read as empty again.
 *
 * Pure and dependency-free — scripts/test-govwatch.ts exercises it against
 * the real incident body shapes.
 */

/** Parse one layer of JSON-string double encoding off a REST body.
 *
 * ASP.NET string-returning endpoints (Tarrant GIS GetWaitTimes) wrap their
 * payload as a JSON string; a caller that already did `res.json()` holds the
 * inner JSON as a plain string. Returns the parsed object for a string that
 * parses, and the input UNCHANGED (not null, not {}) for anything else —
 * objects pass straight through, and a string that does not parse as JSON is
 * a plain-text body the caller should see as itself. Empty/whitespace
 * strings parse as JSON `""`/nothing useful — passed through unchanged.
 * Never throws: a failed parse is a passthrough, so a mislabeled text
 * response can never crash a run. */
export function unwrapJsonString(parsed: unknown): unknown {
  if (typeof parsed !== "string" || parsed.trim() === "") return parsed;
  try {
    return JSON.parse(parsed) as unknown;
  } catch {
    return parsed;
  }
}
