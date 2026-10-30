#!/usr/bin/env node
/**
 * Phase-3 pilot: official wait-time EXTRACTION — fetch seeded gov sources,
 * LLM-extract structured readings, post CHANGES to Slack.
 *
 *   npx tsx scripts/extract-wait-times.ts          # run (fetch → extract → notify)
 *   npx tsx scripts/extract-wait-times.ts --dry   # no Slack, no state write
 *
 * Design (GOVT_WAIT_TIME_SOURCES_PLAN.md §5):
 * - polite fetching: identified UA, robots.txt respected, 20s timeout, max 1
 *   pass per source per run (runs are cron-spaced by meal/poll-close hours)
 * - HTML → focused text: strip scripts/styles, locate the wait-time region,
 *   cap at ~6KB (full pages are too big for cheap extraction)
 * - LLM (flash-lite) strict-JSON extraction → {precinct_name, wait_minutes,
 *   wait_category, last_updated, confidence}; normalization: range → midpoint,
 *   categorical words → category, "N people in line" → ~N min
 * - change detection vs data/govt-readings.json (per source+precinct):
 *   only CHANGED/NEW readings post to Slack; JS-walled pages report as
 *   confidence 0 (plan §5: "Map-only: cannot extract")
 * - freshness + hours gates (issue #12): a wait value frozen across N
 *   consecutive runs, or a reading observed outside the site's hours of
 *   operation, is recorded (state + observation bus) but never posted to
 *   the volunteer feed — the county's own app renders N/A for the same
 *   data (see src/govt/gates.ts)
 * - every reading appends to data/observations.jsonl as domain "govt"
 *   with the raw REST attributes as evidence
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openrouterChat } from "../src/describe/openrouter.js";
import { settings } from "../src/config.js";
import {
  FRESHNESS_FROZEN_RUNS,
  OUTSIDE_HOURS_CONFIDENCE,
  freshnessConfidence,
  hoursSpecFromFields,
  isWithinHours,
  waitMinutesFromSeconds,
  markVanishedSites,
  nextFreshness,
  refreshAdvanced,
  type ReadingState,
} from "../src/govt/gates.js";
import { hasGovtEvidence } from "../src/govt/evidence.js";
import { MIN_POST_MINUTES } from "../src/notify/format.js";
import { createResolveDeps, resolveLocation } from "../src/locate/resolve.js";
import type { DescriptionSet, Observation } from "../src/types.js";

const UA = "PizzaToThePolls/1.0 (civic-data wait-times; +https://polls.pizza)";
const DRY = process.argv.includes("--dry");
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const SOURCES_PATH = resolve(
  process.env.WAIT_TIME_SOURCES ?? "./config/govt-sources.jsonl",
);

/** Screenshot actor (pay-per-event ≈ $0.0015) — the JS-wall fallback:
 *  ArcGIS dashboards / Airtable galleries render client-side; the vision
 *  model reads the rendered table from pixels. */
async function screenshotUrl(url: string): Promise<string | null> {
  if (!settings.apifyToken) return null;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/moonweil~url-screenshot-api/run-sync-get-dataset-items?token=${encodeURIComponent(settings.apifyToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(180000),
      },
    );
    if (!res.ok) return null;
    const items = (await res.json()) as { screenshotUrl?: string }[];
    return items[0]?.screenshotUrl ?? null;
  } catch {
    return null;
  }
}

interface Source {
  scope: string;
  state: string;
  county: string | null;
  source_type: string;
  url: string;
  display_label: string;
  notes?: string;
  /** Best public page for HUMAN verification (not the extraction URL —
   *  REST sources' url is a JSON API; the locator app may render blank).
   *  Falls back to url. */
  verify_url?: string;
  /** PASSED human verification (checked against the county's public page) —
   *  eligible for the volunteer-facing feed. Vetting channel gets everything. */
  graduated?: boolean;
  /** Optional pizzabase `locations` id (issue #35): config-side mirror of
   *  wait_time_sources.location_id for sources whose URL doesn't match the
   *  DB row — wins over the URL registry join. Absent → fuzzy path. */
  location_id?: number | string;
  /** Structured REST extraction (the map app's own backend API) — preferred
   *  path when found: no browser, no vision, exact fields. */
  rest?: {
    type: "arcgis" | "json-post";
    url: string;
    /** json-post: form-encoded body */
    form?: Record<string, string>;
    /** json-post: path to records array ("a.b") */
    recordsPath?: string;
    nameField: string;
    /** fallback name fields (Clark EV rows: SITE_NAME null, names live in SHORTNAME/Location) */
    nameFallbackFields?: string[];
    /** stable per-site key (dedupe/collision) — e.g. Clark POLL_CODE. Defaults to name. */
    keyField?: string;
    /** physical address fields (dispatch gate: volunteer needs an address to act) */
    addressFields?: string[];
    /** Live wait field in SECONDS (Clark NV: WAIT_TIME_secs — the WAIT_TIME
     *  minutes field died Oct 21 while secs keeps ticking; the county card
     *  renders secs/60). AUTHORITATIVE and exclusive when set: no fallback
     *  to waitMinutesField (null secs = not reporting = N/A, like the card). */
    waitSecondsField?: string;
    waitMinutesField?: string;
    waitTextField?: string;
    lineCountField?: string;
    peopleField?: string;
    updatedField?: string;
    /** Field whose value flags a site closed (e.g. "Closed") — such readings
     *  are recorded but never posted (hours gate, issue #12). */
    isOpenField?: string;
    /** Uniform hours of operation "HH:MM-HH:MM" local — readings observed
     *  outside them are recorded but never posted (issue #12 hours gate). */
    defaultHours?: string;
    /** Per-row open/close time fields (24-hour "HH:MM[:ss…]") — build a
     *  per-site hours spec that takes precedence over defaultHours when
     *  parseable (Clark sites vary: Hend City Hall 08:00-17:00). */
    openTimeField?: string;
    closeTimeField?: string;
    /** IANA timezone used to evaluate defaultHours (e.g. America/Los_Angeles). */
    timezone?: string;
  };
}

interface Reading {
  precinct_name: string;
  /** stable site key (rest path: e.g. POLL_CODE) — dedupes when names are messy */
  site_key?: string;
  /** physical address for volunteer action (dispatch gate requires it) */
  address?: string | null;
  wait_minutes: number | null;
  wait_category: string | null;
  last_updated: string | null;
  confidence: number;
  // ── gate metadata + raw REST evidence (issue #12) ──
  /** Raw REST wait field value (unparsed) — evidence trail / freshness input */
  raw_wait_time?: number | string | null;
  /** Raw REST last-refresh field value (unparsed) — evidence trail */
  last_refresh?: string | null;
  /** Consecutive runs the wait value has been unchanged (freshness gate) */
  frozen_count?: number;
  /** Wait field frozen across FRESHNESS_FROZEN_RUNS runs — never vol-posted */
  stale?: boolean;
  /** Observed outside the site's hours of operation — recorded, never posted */
  outside_hours?: boolean;
  /** Why the hours gate tripped (reason string for vetting/console) */
  hours_reason?: string;
  /** Per-site hours spec "HH:MM-HH:MM" (from REST open/close fields) —
   *  preferred over the source-wide defaultHours by the hours gate */
  hours_spec?: string | null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function loadSources(): Source[] {
  return readFileSync(SOURCES_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Source & { is_active: boolean })
    .filter((s) => s.is_active !== false);
}

async function robotsAllows(url: URL): Promise<boolean> {
  try {
    const res = await fetch(new URL("/robots.txt", url.origin).toString(), {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return true;
    const txt = (await res.text()).slice(0, 4000).toLowerCase();
    const path = url.pathname;
    // minimal: honor blanket disallows for our UA/star on this path
    for (const block of txt.split(/\r?\n/)) {
      const m = block.match(/^disallow:\s*(\S+)/);
      if (m) {
        const dis = m[1]!;
        if (dis === "/" || (dis !== "" && path.startsWith(dis))) return false;
      }
    }
    return true;
  } catch {
    return true; // fail open — fetching a public page, robots fetch itself failed
  }
}

function htmlToFocusedText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  // locate wait-relevant region (± around first wait keyword), cap 6000 chars
  const m = stripped.match(/.{0,1600}\bwait[a-z -]{0,12}.{0,4400}/i);
  return m ? m[0] : stripped.slice(0, 6000);
}

async function fetchPage(url: string): Promise<string | null> {
  const u = new URL(url);
  if (!(await robotsAllows(u))) {
    console.log(`  [robots] ${url.slice(0, 70)} — disallowed, skipping`);
    return null;
  }
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`  [http ${res.status}] ${url.slice(0, 70)}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(
      `  [fetch fail] ${url.slice(0, 70)}: ${String(err).slice(0, 60)}`,
    );
    return null;
  }
}

function normalizeRange(text: string): number | null {
  // "About 30 minutes" / "Approximately 45 min" — strip leading words
  const stripped = text.replace(/^[^0-9]{0,20}/, "");
  // "20-30 min" → 25
  const range = stripped.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(min|minute)/i);
  if (range) return Math.round((Number(range[1]) + Number(range[2])) / 2);
  const m = stripped.match(/(\d{1,3})\s*(min|minute)/i);
  if (m) return Number(m[1]);
  // bare number (no unit) — e.g. Guilford FeatureServer Wait:"30"
  const bare = stripped.match(/^(\d{1,3})\b/);
  if (bare) return Number(bare[1]);
  return null;
}

async function extractReadings(text: string): Promise<Reading[]> {
  const raw = await openrouterChat({
    model: settings.textModel,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract polling-place wait times from this webpage text. Respond with strict JSON: " +
          '{"readings": [{"precinct_name": <string>, "address": <street address if present, else null>, "wait_minutes": <int minutes or null>, ' +
          '"wait_category": <"short"|"medium"|"long"|null>, "last_updated": <string or null>, ' +
          '"confidence": <0..1 how certain the reading is>}]. Rules: a range like "20-30 min" → midpoint. ' +
          'Categorical words ("short","moderate","long") → wait_category. "N people in line" → ~N minutes. ' +
          "If NO concrete wait times for specific places appear in the text, return an empty readings array. " +
          "Do not invent numbers.",
      },
      { role: "user", content: text.slice(0, 6000) },
    ],
  });
  try {
    const j = JSON.parse(
      raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
    ) as {
      readings?: unknown[];
    };
    return (j.readings ?? [])
      .map((r) => r as Record<string, unknown>)
      .map((r) => {
        const name =
          String(r.precinct_name ?? "").trim() || "(unnamed location)";
        const address =
          typeof r.address === "string" &&
          r.address.trim() &&
          !/^null$/i.test(r.address.trim())
            ? r.address.trim()
            : null;
        const rawMin = r.wait_minutes;
        let minutes =
          typeof rawMin === "number"
            ? rawMin
            : typeof rawMin === "string"
              ? normalizeRange(rawMin)
              : null;
        if (minutes != null && (minutes < 0 || minutes > 600)) minutes = null;
        const cat = ["short", "medium", "long"].includes(
          String(r.wait_category),
        )
          ? String(r.wait_category)
          : null;
        const conf = Math.min(Math.max(Number(r.confidence ?? 0), 0), 1);
        return {
          precinct_name: name,
          address,
          wait_minutes: minutes,
          wait_category: cat,
          last_updated:
            typeof r.last_updated === "string" ? r.last_updated : null,
          confidence: conf,
        } satisfies Reading;
      });
  } catch {
    return [];
  }
}

/** Vision extraction: read a rendered screenshot's wait-time table.
 *  JS-walled sources (ArcGIS/Airtable render client-side) fall back to
 *  this — screenshot (browser) + flash-lite reads the pixels. */
async function visionExtractReadings(shotUrl: string): Promise<Reading[]> {
  const imgRes = await fetch(shotUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) return [];
  const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
  const raw = await openrouterChat({
    model: settings.visionModel,
    max_tokens: 900,
    messages: [
      {
        role: "system",
        content:
          "You read screenshots of polling wait-time tables. Output strict JSON only: " +
          '{"readings":[{"place":<site name>,"address":<street address if visible, else null>,"wait":"<e.g. 25 min / 20-30 min / No Wait>"}],"page_title":<string>,"has_data":<boolean>}',
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Extract every visible wait-time entry from this screenshot. Place names exactly as shown.",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` },
          },
        ],
      },
    ],
  });
  try {
    const j = JSON.parse(
      raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
    ) as {
      readings?: { place?: unknown; wait?: unknown }[];
    };
    return (j.readings ?? [])
      .map((r) => {
        const name = String(r.place ?? "").trim() || "(unnamed location)";
        const address =
          typeof r.address === "string" &&
          r.address.trim() &&
          !/^null$/i.test(r.address.trim())
            ? r.address.trim()
            : null;
        const waitStr = String(r.wait ?? "");
        const minutes = normalizeRange(`${waitStr} min`);
        const cat = /no wait|none/i.test(waitStr)
          ? "short"
          : /short/i.test(waitStr)
            ? "short"
            : /long/i.test(waitStr)
              ? "long"
              : null;
        return {
          precinct_name: name,
          address,
          wait_minutes: minutes,
          wait_category: cat,
          last_updated: null,
          confidence: 0.75,
        } satisfies Reading;
      })
      .filter((r) => r.wait_minutes != null || r.wait_category != null);
  } catch {
    return [];
  }
}

/** Structured REST extraction — read the map app's own backend API.
 *  ("Map-interact, option 2": apps like HarrisVotes/Bexar/Clark/Guilford
 *  are consumers of JSON endpoints we can consume directly — no browser.)
 *  Returns [] on any failure so callers fall through to text/vision. */
async function restExtractReadings(s: Source): Promise<Reading[]> {
  const r = s.rest;
  if (!r) return [];
  try {
    let records: Record<string, unknown>[] = [];
    if (r.type === "arcgis") {
      const res = await fetch(r.url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) return [];
      const j = (await res.json()) as {
        features?: { attributes?: Record<string, unknown> }[];
      };
      records = (j.features ?? []).map((f) => f.attributes ?? {});
    } else {
      const body = new URLSearchParams(r.form ?? {}).toString();
      const res = await fetch(r.url, {
        method: "POST",
        headers: {
          "user-agent": UA,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return [];
      const j = (await res.json()) as Record<string, unknown>;
      let node: unknown = j;
      if (r.recordsPath) {
        for (const part of r.recordsPath.split(".")) {
          node = (node as Record<string, unknown>)?.[part];
          if (node == null) break;
        }
      }
      records = Array.isArray(node) ? (node as Record<string, unknown>[]) : [];
    }
    return (
      records
        .map((rec) => {
          const name = String(
            [r.nameField, ...(r.nameFallbackFields ?? [])]
              .map((f) => rec[f])
              .find((v) => v != null && String(v).trim() !== "") ?? "",
          ).trim();
          const siteKey =
            r.keyField != null && rec[r.keyField] != null
              ? `${String(rec[r.keyField]).trim()}`
              : undefined;
          const address =
            r.addressFields
              ?.map((f) => rec[f])
              .filter((v) => v != null && String(v).trim() !== "")
              .map((v) => String(v).trim())
              .join(", ") || null;
          // ── Wait value (issue #12 root cause, 2026-10-29) ──
          // waitSecondsField, when configured, is AUTHORITATIVE and exclusive:
          // Clark NV's live field is WAIT_TIME_secs while its WAIT_TIME minutes
          // field has been dead since Oct 21 — falling back to the minutes
          // field when secs is null would resurrect the #12 bug (the county
          // card renders N/A for null secs; so do we).
          let minutes: number | null = null;
          if (r.waitSecondsField != null) {
            minutes = waitMinutesFromSeconds(rec[r.waitSecondsField]);
          } else {
            const rawMin =
              r.waitMinutesField != null ? rec[r.waitMinutesField] : undefined;
            minutes =
              typeof rawMin === "number"
                ? rawMin
                : rawMin != null
                  ? normalizeRange(String(rawMin))
                  : null;
            if (minutes != null && (minutes < 0 || minutes > 600))
              minutes = null;
          }
          const rawWaitVal =
            r.waitSecondsField != null
              ? rec[r.waitSecondsField]
              : r.waitMinutesField != null
                ? rec[r.waitMinutesField]
                : undefined;
          const hours_spec =
            r.openTimeField != null && r.closeTimeField != null
              ? hoursSpecFromFields(rec[r.openTimeField], rec[r.closeTimeField])
              : null;
          const text =
            r.waitTextField != null ? String(rec[r.waitTextField] ?? "") : "";
          if (minutes == null && text) minutes = normalizeRange(text);
          const cat =
            minutes == null
              ? /short|no wait|zero|closed/i.test(text)
                ? "short"
                : /long/i.test(text)
                  ? "long"
                  : null
              : null;
          // "Closed" is a valid reading (site exists, not open) — record 0-min so
          // change detection sees Closed→30min when polls open. Don't drop on null minutes
          // when the text carries a status word.
          const minutes2 = minutes ?? (/closed/i.test(text) ? 0 : null);
          const people = r.peopleField != null ? rec[r.peopleField] : undefined;
          const extra =
            people != null && Number(people) > 0 ? ` (${people} in line)` : "";
          // (B) Esri Election Management joins stamp the wait-tracking
          // table's edit date with a per-deployment hash suffix
          // (EditDate_1582734843112) — sniff it when no updatedField is
          // configured so the freshness gate can distinguish live-but-steady
          // values from dead fields.
          const updatedField =
            r.updatedField ??
            Object.keys(rec).find((k) => /^EditDate_\d+$/.test(k));
          const lastRefreshRaw =
            updatedField != null ? rec[updatedField] : undefined;
          const statusText =
            r.isOpenField != null ? String(rec[r.isOpenField] ?? "") : "";
          return {
            precinct_name: (name || "(unnamed)") + extra,
            site_key: siteKey,
            address,
            wait_minutes: minutes ?? minutes2,
            wait_category: cat,
            last_updated:
              lastRefreshRaw != null ? String(lastRefreshRaw) : null,
            confidence: 0.95, // structured API — near-certain
            // Raw REST attributes ride on the reading (issue #12): evidence for
            // audits, freshness-gate input, and status-field hours gating.
            raw_wait_time:
              typeof rawWaitVal === "number" || typeof rawWaitVal === "string"
                ? rawWaitVal
                : null,
            hours_spec,
            last_refresh:
              lastRefreshRaw != null ? String(lastRefreshRaw) : null,
            ...(r.isOpenField != null && /closed/i.test(statusText)
              ? {
                  outside_hours: true,
                  hours_reason: `status field reports "${statusText}"`,
                }
              : {}),
          } satisfies Reading;
        })
        // Keep NAMED rows even when the wait value is null: a successful REST
        // query returning sites with no current wait (overnight, pre-open, or
        // Esri Election Management `waittime` nulls) is NOT a JS-wall miss.
        // Dropping them made main() escalate to screenshot+vision on the raw
        // JSON URL — useless pixels, 3-minute Apify timeouts, and per-run cost
        // across the 2026-10-30 43-source sweep. Null-wait rows record state
        // ("site not reporting"), keep vanished-site tracking honest, chain
        // frozen-history for the freshness gate, and never post (null < any
        // threshold). Only rows that are BOTH unnamed and waitless are garbage.
        .filter(
          (x) =>
            x.wait_minutes != null ||
            x.wait_category != null ||
            !/^\(unnamed\)/.test(x.precinct_name),
        )
    );
  } catch {
    return [];
  }
}

/** Vetting floor: changed readings >= this post to the VETTING channel
 *  (source-health noise is the point of vetting; pure no-wait flapping is
 *  not). Volunteer channel only ever gets >= MIN_POST_MINUTES. */
const VETTING_MIN_MINUTES = 15;

/** Footer link for the source. Incoming-webhook `text` renders literally —
 *  mrkdwn angle-bracket links (`<url|label>`) show as raw text and the link
 *  dies. Plain URL on its own line auto-links. */
function linkLine(url: string, label: string): string {
  return `Source: ${url} (${label.slice(0, 60)})`;
}

function volChannelLine(r: Reading, prev: ReadingState | undefined): string {
  const val =
    r.wait_minutes != null ? `${r.wait_minutes} min` : (r.wait_category ?? "?");
  const was = prev
    ? prev.minutes != null
      ? ` (was ${prev.minutes} min)`
      : prev.category
        ? ` (was ${prev.category})`
        : " (new)"
    : " (new)";
  return `• ${r.precinct_name.slice(0, 50)}: ${val}${was} — ${pct(r.confidence)}`;
}

async function slackPost(
  text: string,
  channel: "vetting" | "vols" = "vetting",
): Promise<void> {
  const url =
    channel === "vols" && settings.volsWebhookUrl
      ? settings.volsWebhookUrl
      : settings.slackWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        username: "feedflag",
        icon_emoji: ":feedflag:",
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.warn(`  [slack fail] ${String(err).slice(0, 80)}`);
  }
}

function loadState(): Record<string, ReadingState> {
  const p = join(DATA_DIR, "govt-readings.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, ReadingState>;
  } catch {
    return {};
  }
}

/** ─── Evaluation: stress-test readings before they reach the vol feed ───
 *
 * Criteria (human-vetted design, 2026-10-21):
 *  1. ACTABILITY — volunteer can act: site name (not "(unnamed)"), physical
 *     address, working verify link (verify_url renders).
 *  2. AGREEMENT — the posted number agrees with what a human sees on the
 *     county's public page. Raw REST fields are NOT enough by construction
 *     (issue #12: the public app applies staleness/hours display logic on
 *     top of the raw field — we posted "65 min" while the county card
 *     showed N/A); freshness-gate and hours-gate verdicts must be clean.
 *  3. DISPATCH GATE — could we send pizzas here: everything above + >= 60 min
 *     (or 'long') + source graduated (human decision in config).
 */
interface Evaluation {
  reasons: string[];
  dispatchable: boolean;
}

const verifyCache = new Map<string, boolean>();
async function verifyLinkOk(url: string): Promise<boolean> {
  if (verifyCache.has(url)) return verifyCache.get(url)!;
  let ok = false;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  verifyCache.set(url, ok);
  return ok;
}

async function evaluateReading(s: Source, r: Reading): Promise<Evaluation> {
  const reasons: string[] = [];
  // 1. Actability
  if (!r.precinct_name || /^\(unnamed\)/.test(r.precinct_name))
    reasons.push("no site name");
  if (!r.address) reasons.push("no address");
  const vurl = s.verify_url ?? s.url;
  if (!vurl) {
    reasons.push("no verify link");
  } else if (!(await verifyLinkOk(vurl))) {
    reasons.push("verify link dead");
  }
  // 2. Agreement — the freshness + hours gates run upstream; their verdicts
  // ride on the reading and block dispatch here too (defense in depth).
  if (r.stale)
    reasons.push(`stale: wait field frozen ${r.frozen_count ?? "?"} run(s)`);
  if (r.outside_hours)
    reasons.push(r.hours_reason ?? "outside hours of operation");
  if (r.confidence < 0.6) reasons.push(`low confidence ${pct(r.confidence)}`);
  // 3. Dispatch gate
  const dispatchable =
    reasons.length === 0 &&
    s.graduated === true &&
    ((r.wait_minutes ?? -1) >= MIN_POST_MINUTES || r.wait_category === "long");
  return { reasons, dispatchable };
}

const REPORT = process.argv.includes("--report");
/** Board from committed state only — no extraction, no keys needed. */
const REPORT_ONLY = process.argv.includes("--report-only");

async function reportBoard(
  sources: Source[],
  state: Record<string, ReadingState>,
): Promise<void> {
  console.log(
    "\n## Evaluation board (stress test: actable? agrees? dispatchable?)\n",
  );
  console.log(
    "| source | readings | named | addressed | verify | graduated | dispatchable |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const s of sources) {
    const entries = Object.entries(state).filter(([k]) => k.startsWith(s.url));
    const evals = await Promise.all(
      entries.map(([k, v]) =>
        evaluateReading(s, {
          precinct_name: k.slice(s.url.length + 1),
          wait_minutes: v.minutes,
          wait_category: v.category,
          confidence: v.confidence,
          address: v.address ?? null,
          last_updated: v.updated,
        }),
      ),
    );
    const named = entries.filter(([k]) => !k.includes("(unnamed)")).length;
    const addressed = entries.filter(([, v]) => v.address).length;
    const vok = await verifyLinkOk(s.verify_url ?? s.url);
    const dispatchable = evals.filter((e) => e.dispatchable).length;
    console.log(
      `| ${s.state} ${s.county ?? ""} | ${entries.length} | ${named} | ${addressed} | ${vok ? "OK" : "DEAD"} | ${s.graduated ? "✅" : "🧪"} | ${dispatchable} |`,
    );
    const failReasons = new Set(evals.flatMap((e) => e.reasons));
    if (failReasons.size)
      console.log(
        `\n  ${s.state} ${s.county ?? ""} — blockers: ${[...failReasons].join("; ")}`,
      );
  }
  console.log("");
}

const main = async () => {
  if (REPORT_ONLY) {
    await reportBoard(loadSources(), loadState());
    return;
  }
  if (!settings.openrouterKey)
    throw new Error("OPENROUTER_API_KEY not configured");
  const sources = loadSources();
  const state = loadState();
  // Issue #35: one resolver for the whole run — the pizzabase registry /
  // locations caches are shared across a source's readings (read-only).
  const resolver = createResolveDeps();
  const next: Record<string, ReadingState> = {};
  let totalChanged = 0;

  for (const s of sources) {
    const label = `${s.state} ${s.county ?? "(statewide)"} — ${s.display_label.slice(0, 48)}`;
    console.log(`[govt] ${label}`);
    try {
      let readings = await restExtractReadings(s);
      let method: string | null = readings.length > 0 ? "rest" : null;
      let html: string | null = null;
      // source_type "api" (REST/JSON) sources NEVER escalate to the
      // browser paths: a screenshot of a JSON response cannot yield better
      // data than the query that already ran (0 rows = cycle not loaded or
      // nothing reporting — carry forward, next run retries). Without this,
      // every empty-result run burned an Apify screenshot + 3-min vision
      // call on the raw JSON URL (2026-10-30 sweep finding).
      if (readings.length === 0 && s.source_type === "api") {
        console.log(
          `  0 readings (REST empty — cycle not loaded or nothing reporting)`,
        );
        for (const [k, v] of Object.entries(state)) {
          if (k.startsWith(s.url)) next[k] = v;
        }
        continue;
      }
      if (readings.length === 0) {
        html = await fetchPage(s.url);
        if (html == null) {
          console.log(
            `  no content — JS-walled, down, or robots-blocked; reporting stale`,
          );
          // carry forward last known readings (no update)
          for (const [k, v] of Object.entries(state)) {
            if (k.startsWith(s.url)) next[k] = v;
          }
          continue;
        }
      } // end rest-miss → html path
      if (readings.length === 0 && html != null) {
        const text = htmlToFocusedText(html);
        readings = await extractReadings(text);
        method = readings.length > 0 ? "text" : null;
      }
      if (readings.length === 0 && html != null) {
        // JS-walled (ArcGIS dashboards / Airtable galleries render client-side):
        // fall back to screenshot + vision extraction (plan §5 “Map-only” case)
        console.log(`  text path empty — trying screenshot+vision`);
        const shot = await screenshotUrl(s.url);
        if (shot) {
          readings = await visionExtractReadings(shot);
          method = readings.length > 0 ? "vision" : null;
        }
      }
      if (readings.length === 0) {
        console.log(
          `  0 readings (JS-walled even via screenshot, or no data published)`,
        );
        // carry forward prior state — a transient empty response must not
        // wipe per-site history (frozenCount, addresses) or the change-
        // detection base (issue #12: tolerate county row churn)
        for (const [k, v] of Object.entries(state)) {
          if (k.startsWith(s.url)) next[k] = v;
        }
      } else {
        console.log(`  ${readings.length} reading(s) via ${method}`);
      }
      const volChanges: string[] = [];
      const vetChanges: string[] = [];
      const seenKeys = new Set<string>();
      const gatedReadings: Reading[] = [];
      for (const r of readings) {
        const key = `${s.url}#${r.site_key ?? r.precinct_name}`;
        seenKeys.add(key);
        // a vanished-then-returned site is a new episode: no stale history,
        // no consumed announcement (county row churn, issue #12)
        let prev = state[key];
        if (prev?.active === false) prev = undefined;
        const changed =
          !prev ||
          prev.minutes !== r.wait_minutes ||
          prev.category !== r.wait_category;

        // ── Gates (issue #12) — applied before any posting decision ──
        let gated: Reading = { ...r };
        if (method === "rest") {
          // FRESHNESS GATE: a WAIT_TIME identical across consecutive runs is a
          // frozen field, not a live queue (Clark: 60/61 sites frozen for days
          // while the county card showed N/A). Stale readings keep recording
          // but never reach the vol feed.
          const fv = nextFreshness(gated.wait_minutes, prev);
          // (B) TIMESTAMP-AWARE: identical values only count as frozen when
          // the county's refresh stamp is frozen too. A stamp that keeps
          // advancing (Clark Last_Refresh, Washoe MWTupdate, Esri EditDate_*)
          // proves the queue is live even when the number sits flat — a real
          // 90-minute line held steady for an hour was suppressed as
          // "frozen" before it could ever post (2026-10-30 Clay MO).
          const stampMoved = refreshAdvanced(
            gated.last_refresh,
            prev?.lastRefresh,
          );
          gated = {
            ...gated,
            frozen_count: stampMoved ? 0 : fv.frozenCount,
            stale: stampMoved ? false : fv.stale,
            confidence: stampMoved
              ? gated.confidence
              : freshnessConfidence(gated.confidence, fv),
          };
        }
        const hoursSpec = gated.hours_spec ?? s.rest?.defaultHours;
        if (hoursSpec && s.rest?.timezone) {
          // HOURS GATE: readings observed outside the site's hours of
          // operation are recorded but never posted (pre-open churn is noise —
          // the 08:13 PT "65 min" post fired 47 min before opening).
          // Per-site hours (Clark rows carry START_TIME/END_TIME — Hend City
          // Hall runs 08:00-17:00, not the 09:00-18:00 county default) take
          // precedence; the source-wide defaultHours is the fallback.
          const hv = isWithinHours(hoursSpec, s.rest.timezone);
          if (!hv.open) {
            gated = {
              ...gated,
              outside_hours: true,
              hours_reason: hv.reason,
              confidence: Math.min(gated.confidence, OUTSIDE_HOURS_CONFIDENCE),
            };
          } else if (hv.reason) {
            console.log(`  [hours] gate failed open: ${hv.reason}`);
          }
        }

        // record EVERYTHING in state (change detection needs the full picture;
        // gate metadata rides along so the next run can chain frozenCount)
        gatedReadings.push(gated);
        next[key] = {
          minutes: gated.wait_minutes,
          category: gated.wait_category,
          updated: gated.last_updated,
          confidence: gated.confidence,
          at: new Date().toISOString(),
          address: gated.address ?? prev?.address ?? null,
          rawWaitTime: gated.raw_wait_time ?? null,
          lastRefresh: gated.last_refresh ?? null,
          frozenCount: gated.frozen_count ?? 0,
          active: true,
          announced: prev?.announced ?? false,
        };

        // HOURS-GATED: state + observation bus only — no Slack, either channel
        if (gated.outside_hours) {
          if (changed)
            console.log(
              `  [hours] ${gated.precinct_name.slice(0, 40)}: recorded only — ${gated.hours_reason ?? "outside hours"}`,
            );
          continue;
        }

        // FRESHNESS-GATED: never vol-posted. One-time vetting flag on the run
        // staleness trips; silent state updates after (no per-run spam).
        if (gated.stale) {
          const prevStale = (prev?.frozenCount ?? 0) >= FRESHNESS_FROZEN_RUNS;
          if (!prevStale) {
            vetChanges.push(
              `⏸️ ${volChannelLine(gated, prev)} — WAIT_TIME frozen ${gated.frozen_count} run(s)` +
                ` (raw=${JSON.stringify(gated.raw_wait_time ?? null)}, Last_Refresh=${gated.last_refresh ?? "?"}) — withheld from vol feed`,
            );
            console.log(
              `  [stale] ${gated.precinct_name.slice(0, 40)}: frozen ${gated.frozen_count} run(s) — vol post withheld`,
            );
          }
          continue;
        }

        const line = volChannelLine(gated, prev);
        const mins = gated.wait_minutes ?? -1;
        const volEligible =
          mins >= MIN_POST_MINUTES || gated.wait_category === "long";
        if (!volEligible) {
          if (prev?.announced) next[key].announced = false; // cooled — re-arm
          if (
            changed &&
            mins >= VETTING_MIN_MINUTES &&
            settings.volsWebhookUrl
          ) {
            // two-channel mode: vetting tier sees churn for source smell-tests
            vetChanges.push(line);
          }
          continue;
        }
        // (A) FIRST-DISPATCH ANNOUNCEMENT: a hot line posts once on its first
        // eval-clean observation even if the value is UNCHANGED — steady
        // queues rarely trip the change-only trigger (Esri counties stamp in
        // 30-60min batches; Clay MO sat at 90 min for an hour without a single
        // change-based post). After the announcement, change-only resumes;
        // cooling below the threshold re-arms it for the next episode.
        const announce = !prev?.announced;
        const post = changed || announce;
        if (!post) continue; // steady + already announced — quiet
        const evaluation = await evaluateReading(s, gated);
        totalChanged++;
        next[key].announced = true; // the attempt is consumed, post or block
        // VOL FEED (graduated sources only): dispatch signal = lines >= 1 hour
        // AND eval-clean (name + address + live verify link + fresh).
        // Single-channel mode (no vols webhook): the one channel is VOL-GRADE —
        // sub-60min churn stays in console/state/digest until a vols channel
        // exists (user call 2026-10-21: "15-min posts are not helpful").
        if (evaluation.dispatchable) {
          volChanges.push(
            line + (r.address ? ` — ${r.address.slice(0, 50)}` : ""),
          );
          vetChanges.push(
            line + (r.address ? ` — ${r.address.slice(0, 50)}` : ""),
          );
        } else {
          // eval-blocked: visible in vetting with reasons, never vol-posted
          vetChanges.push(
            `🚫 ${line} — eval: ${evaluation.reasons.join("; ")}`,
          );
        }
      }
      // Site-removal tolerance (issue #12): the county adds/removes rows
      // between runs (Clark shrank 61 → 36 mid-window) — vanished sites are
      // marked inactive in state, not silently deleted. Only on a real REST
      // result set: a failed/empty fetch must never mark sites inactive.
      if (method === "rest" && readings.length > 0) {
        const vanished = markVanishedSites(s.url, state, next, seenKeys);
        if (vanished.length)
          console.log(`  marked ${vanished.length} vanished site(s) inactive`);
      }
      // Single-channel mode (no vols webhook): the vol post below is the
      // ONLY delivery (webhook fallback), so a vetting post here would
      // duplicate it in the same channel (dupes seen 2026-10-26 El Paso).
      if (!DRY && vetChanges.length > 0 && settings.volsWebhookUrl) {
        const msg =
          `:stopwatch: *Wait-time update* — ${s.state} ${s.county ?? ""}` +
          `${s.graduated ? " ✅" : " 🧪"}\n` +
          vetChanges.slice(0, 14).join("\n") +
          `\n${linkLine(s.verify_url ?? s.url, s.display_label)}`;
        await slackPost(msg, "vetting");
      }
      if (!DRY && volChanges.length > 0) {
        const msg =
          `:stopwatch: *Wait-time update* — ${s.state} ${s.county ?? ""} (verified source)\n` +
          volChanges.slice(0, 14).join("\n") +
          `\n${linkLine(s.verify_url ?? s.url, s.display_label)}`;
        await slackPost(msg, "vols");
        console.log(
          `  posted ${vetChanges.length} vetting / ${volChanges.length} vol change(s)`,
        );
      } else if (vetChanges.length > 0) {
        console.log(
          `  [dry] ${vetChanges.length} vetting / ${volChanges.length} vol change(s) not posted`,
        );
      }
      // observations for the bus (domain govt)
      if (!DRY) {
        mkdirSync(DATA_DIR, { recursive: true });
        const observedAt = new Date().toISOString();
        // gated readings, not raw: the observation must reflect the gate
        // verdicts (confidence, staleness) a downstream consumer would act on
        const rows = gatedReadings.flatMap((r) => {
          const sourceRef = `${s.url}#${r.site_key ?? r.precinct_name}`;
          // Raw-field evidence (issue #12): audits must not need to re-query
          // the API to reconstruct why a reading was posted or withheld.
          const evidence: Record<string, unknown> = {
            method: method ?? "unknown",
            rawWaitTime: r.raw_wait_time ?? null,
            lastRefresh: r.last_refresh ?? null,
            frozenCount: r.frozen_count ?? 0,
            stale: r.stale ?? false,
            outsideHours: r.outside_hours ?? false,
            hoursReason: r.hours_reason ?? null,
            sourceUrl: s.rest?.url ?? s.url,
          };
          const description: DescriptionSet = {
            item: {
              id: sourceRef,
              platform: "site",
              authorHandle: s.display_label.slice(0, 40),
              postedAt: r.last_updated ?? observedAt,
              caption: `Govt wait-time reading — ${s.state} ${s.county ?? ""}`,
              hashtags: [],
              mediaUrls: [],
              source: `govt-extraction:${method ?? "unknown"}`,
            },
            caption:
              `REST field evidence: wait=${JSON.stringify(r.raw_wait_time ?? null)}, ` +
              `last_refresh=${r.last_refresh ?? "n/a"}, frozen_run(s)=${r.frozen_count ?? 0}, ` +
              `stale=${r.stale ?? false}, outside_hours=${r.outside_hours ?? false}`,
            imageDescriptions: [],
            evidence,
          };
          // Belt-and-braces (issue #20): an EMPTY evidence block is the
          // pre-gate-code signature (the 2026-10-28 backup wrote frozen
          // Clark waits at 95% with description = {}). Refuse evidenceless
          // govt rows at the writer too, so a stale-code path can never
          // re-inflate confidence onto the bus.
          if (!hasGovtEvidence(description)) {
            console.warn(
              `  [evidence] ${sourceRef}: empty evidence block — observation dropped (pre-gate code signature, issue #20)`,
            );
            return [];
          }
          return [
            {
              observation: {
                schema: "feedflag/observation@1",
                domain: "govt",
                source_ref: sourceRef,
                url: s.url,
                author: s.display_label,
                platform: "govt",
                observed_at: observedAt,
                posted_at: r.last_updated ?? undefined,
                location: {
                  raw: r.precinct_name,
                  state: s.state,
                  county: s.county ?? undefined,
                },
                signal_kind: "wait_time_reading",
                wait_minutes: r.wait_minutes,
                wait_category: r.wait_category,
                confidence: r.confidence,
                provider: settings.textModel,
                relevant: true,
                description,
              } satisfies Observation,
              reading: r,
            },
          ];
        });
        // Issue #35 location triangulation: resolve the actual place behind
        // each raw point label (registry join → fuzzy `locations` match →
        // Jev/context disambiguation) before the bus append. Additive
        // `location.resolved`; read-only lookups; a resolution failure
        // degrades to method "no-match" and never blocks the write
        // (resolveLocation cannot throw — the loop always completes).
        for (const { observation, reading } of rows) {
          observation.location = {
            ...observation.location,
            resolved: await resolveLocation(
              {
                domain: "govt",
                rawLabel: reading.precinct_name,
                address: reading.address ?? null,
                scopeHint: { state: s.state, county: s.county ?? undefined },
                sourceUrl: s.url,
                sourceRef: observation.source_ref,
                author: observation.author,
                registryLocationId: s.location_id ?? null,
              },
              resolver,
            ),
          };
        }
        const lines = rows
          .map(({ observation }) => JSON.stringify(observation))
          .join("\n");
        if (lines)
          appendFileSync(join(DATA_DIR, "observations.jsonl"), lines + "\n");
      }
    } catch (err) {
      // one source's failure must not sink the run — carry forward its state
      console.log(`  [source failed] ${String(err).slice(0, 100)}`);
      for (const [k, v] of Object.entries(state)) {
        if (k.startsWith(s.url)) next[k] = v;
      }
    }
    // persist state incrementally — a crash mid-run keeps completed sources.
    // ATOMIC via tmp+rename: a plain mid-source writeFileSync can leave a
    // torn file for the next run's loadState to swallow as {} (2026-10-30
    // state-clobber incident) — rename is atomic, readers see old-or-new.
    if (!DRY) {
      mkdirSync(DATA_DIR, { recursive: true });
      const statePath = join(DATA_DIR, "govt-readings.json");
      writeFileSync(`${statePath}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${statePath}.tmp`, statePath);
    }
  }

  console.log(
    `[govt] extraction complete: ${sources.length} sources, ${Object.keys(next).length} tracked readings, ${totalChanged} changed${DRY ? " (dry)" : ""}`,
  );
  if (REPORT) await reportBoard(sources, next);
};

main().catch((err) => {
  console.error(`[govt] FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
