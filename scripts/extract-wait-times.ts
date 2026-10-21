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
 * - every reading appends to data/observations.jsonl as domain "govt"
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openrouterChat } from "../src/describe/openrouter.js";
import { settings } from "../src/config.js";

const UA = "PizzaToThePolls/1.0 (civic-data wait-times; +https://polls.pizza)";
/** Lines under this many minutes don't post to Slack (churn noise).
 *  >= 1h is the dispatch-relevant signal. Everything still records to state
 *  + the observation bus. */
const MIN_POST_MINUTES = 60;
const DRY = process.argv.includes("--dry");
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const SOURCES_PATH = resolve(process.env.WAIT_TIME_SOURCES ?? "./config/govt-sources.jsonl");

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
    waitMinutesField?: string;
    waitTextField?: string;
    lineCountField?: string;
    peopleField?: string;
    updatedField?: string;
  };
}

interface Reading {
  precinct_name: string;
  /** stable site key (rest path: e.g. POLL_CODE) — dedupes when names are messy */
  site_key?: string;
  wait_minutes: number | null;
  wait_category: string | null;
  last_updated: string | null;
  confidence: number;
}

interface ReadingState {
  minutes: number | null;
  category: string | null;
  updated: string | null;
  confidence: number;
  at: string;
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
  return (m ? m[0] : stripped.slice(0, 6000));
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
    console.log(`  [fetch fail] ${url.slice(0, 70)}: ${String(err).slice(0, 60)}`);
    return null;
  }
}

function normalizeRange(text: string): number | null {
  // "20-30 min" → 25
  const range = text.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(min|minute)/i);
  if (range) return Math.round((Number(range[1]) + Number(range[2])) / 2);
  const m = text.match(/(\d{1,3})\s*(min|minute)/i);
  if (m) return Number(m[1]);
  // bare number (no unit) — e.g. Guilford FeatureServer Wait:"30"
  const bare = text.match(/^(\d{1,3})$/);
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
          '{"readings": [{"precinct_name": <string>, "wait_minutes": <int minutes or null>, ' +
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
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      readings?: unknown[];
    };
    return (j.readings ?? [])
      .map((r) => r as Record<string, unknown>)
      .map((r) => {
        const name = String(r.precinct_name ?? "").trim() || "(unnamed location)";
        const rawMin = r.wait_minutes;
        let minutes =
          typeof rawMin === "number" ? rawMin : typeof rawMin === "string" ? normalizeRange(rawMin) : null;
        if (minutes != null && (minutes < 0 || minutes > 600)) minutes = null;
        const cat = ["short", "medium", "long"].includes(String(r.wait_category))
          ? String(r.wait_category)
          : null;
        const conf = Math.min(Math.max(Number(r.confidence ?? 0), 0), 1);
        return {
          precinct_name: name,
          wait_minutes: minutes,
          wait_category: cat,
          last_updated: typeof r.last_updated === "string" ? r.last_updated : null,
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
          '{"readings":[{"place":<site name>,"wait":"<e.g. 25 min / 20-30 min / No Wait>"}],"page_title":<string>,"has_data":<boolean>}',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract every visible wait-time entry from this screenshot. Place names exactly as shown." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  });
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      readings?: { place?: unknown; wait?: unknown }[];
    };
    return (j.readings ?? [])
      .map((r) => {
        const name = String(r.place ?? "").trim() || "(unnamed location)";
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
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return [];
      const j = (await res.json()) as { features?: { attributes?: Record<string, unknown> }[] };
      records = (j.features ?? []).map((f) => f.attributes ?? {});
    } else {
      const body = new URLSearchParams(r.form ?? {}).toString();
      const res = await fetch(r.url, {
        method: "POST",
        headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
    return records
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
        const rawMin = r.waitMinutesField != null ? rec[r.waitMinutesField] : undefined;
        let minutes: number | null =
          typeof rawMin === "number" ? rawMin : rawMin != null ? normalizeRange(String(rawMin)) : null;
        if (minutes != null && (minutes < 0 || minutes > 600)) minutes = null;
        const text = r.waitTextField != null ? String(rec[r.waitTextField] ?? "") : "";
        if (minutes == null && text) minutes = normalizeRange(text);
        const cat =
          minutes == null
            ? /short|no wait|zero/i.test(text)
              ? "short"
              : /long/i.test(text)
                ? "long"
                : null
            : null;
        const people = r.peopleField != null ? rec[r.peopleField] : undefined;
        const lines = r.lineCountField != null ? rec[r.lineCountField] : undefined;
        const extra =
          people != null && Number(people) > 0 ? ` (${people} in line)` : lines != null ? ` (${lines} lines)` : "";
        return {
          precinct_name: (name || "(unnamed)") + extra,
          site_key: siteKey,
          wait_minutes: minutes,
          wait_category: cat,
          last_updated:
            r.updatedField != null && rec[r.updatedField] != null
              ? String(rec[r.updatedField])
              : null,
          confidence: 0.95, // structured API — near-certain
        } satisfies Reading;
      })
      .filter((x) => x.wait_minutes != null || x.wait_category != null);
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
  const val = r.wait_minutes != null ? `${r.wait_minutes} min` : r.wait_category ?? "?";
  const was = prev
    ? prev.minutes != null
      ? ` (was ${prev.minutes} min)`
      : prev.category
        ? ` (was ${prev.category})`
        : " (new)"
    : " (new)";
  return `• ${r.precinct_name.slice(0, 50)}: ${val}${was} — ${pct(r.confidence)}`;
}

async function slackPost(text: string, channel: "vetting" | "vols" = "vetting"): Promise<void> {
  const url = channel === "vols" && settings.volsWebhookUrl ? settings.volsWebhookUrl : settings.slackWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        username: "feedflag",
        icon_url: "https://github.com/pizza-to-the-polls.png",
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

const main = async () => {
  if (!settings.openrouterKey) throw new Error("OPENROUTER_API_KEY not configured");
  const sources = loadSources();
  const state = loadState();
  const next: Record<string, ReadingState> = {};
  let totalChanged = 0;

  for (const s of sources) {
    const label = `${s.state} ${s.county ?? "(statewide)"} — ${s.display_label.slice(0, 48)}`;
    console.log(`[govt] ${label}`);
    try {
    let readings = await restExtractReadings(s);
    let method: string | null = readings.length > 0 ? "rest" : null;
    let html: string | null = null;
    if (readings.length === 0) {
      html = await fetchPage(s.url);
    if (html == null) {
      console.log(`  no content — JS-walled, down, or robots-blocked; reporting stale`);
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
      console.log(`  0 readings (JS-walled even via screenshot, or no data published)`);
    } else {
      console.log(`  ${readings.length} reading(s) via ${method}`);
    }
    const volChanges: string[] = [];
    const vetChanges: string[] = [];
    for (const r of readings) {
      const key = `${s.url}#${r.site_key ?? r.precinct_name}`;
      const prev = state[key];
      const changed =
        !prev || prev.minutes !== r.wait_minutes || prev.category !== r.wait_category;
      // record EVERYTHING in state (change detection needs the full picture)
      next[key] = {
        minutes: r.wait_minutes,
        category: r.wait_category,
        updated: r.last_updated,
        confidence: r.confidence,
        at: new Date().toISOString(),
      };
      if (!changed) continue;
      const line = volChannelLine(r, prev);
      const mins = r.wait_minutes ?? -1;
      const volEligible = mins >= MIN_POST_MINUTES || r.wait_category === "long";
      // VOL FEED (graduated sources only): dispatch signal = lines >= 1 hour.
      // Single-channel mode (no vols webhook): the one channel is VOL-GRADE —
      // sub-60min churn stays in console/state/digest until a vols channel
      // exists (user call 2026-10-21: "15-min posts are not helpful").
      if (volEligible) {
        totalChanged++;
        if (s.graduated) volChanges.push(line);
        vetChanges.push(line);
      } else if (mins >= VETTING_MIN_MINUTES && settings.volsWebhookUrl) {
        // two-channel mode: vetting tier sees churn for source smell-tests
        vetChanges.push(line);
      }
    }
    if (!DRY && vetChanges.length > 0) {
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
      console.log(`  posted ${vetChanges.length} vetting / ${volChanges.length} vol change(s)`);
    } else if (vetChanges.length > 0) {
      console.log(
        `  [dry] ${vetChanges.length} vetting / ${volChanges.length} vol change(s) not posted`,
      );
    }
    // observations for the bus (domain govt)
    if (!DRY) {
      mkdirSync(DATA_DIR, { recursive: true });
      const lines = readings
        .map((r) =>
          JSON.stringify({
            schema: "feedflag/observation@1",
            domain: "govt",
            source_ref: `${s.url}#${r.site_key ?? r.precinct_name}`,
            url: s.url,
            author: s.display_label,
            platform: "govt",
            observed_at: new Date().toISOString(),
            posted_at: r.last_updated ?? undefined,
            location: { raw: r.precinct_name, state: s.state, county: s.county ?? undefined },
            signal_kind: "wait_time_reading",
            wait_minutes: r.wait_minutes,
            wait_category: r.wait_category,
            confidence: r.confidence,
            provider: settings.textModel,
            relevant: true,
          }),
        )
        .join("\n");
      if (lines) appendFileSync(join(DATA_DIR, "observations.jsonl"), lines + "\n");
    }
    } catch (err) {
      // one source's failure must not sink the run — carry forward its state
      console.log(`  [source failed] ${String(err).slice(0, 100)}`);
      for (const [k, v] of Object.entries(state)) {
        if (k.startsWith(s.url)) next[k] = v;
      }
    }
    // persist state incrementally — a crash mid-run keeps completed sources
    if (!DRY) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(join(DATA_DIR, "govt-readings.json"), JSON.stringify(next, null, 2));
    }
  }

  console.log(
    `[govt] extraction complete: ${sources.length} sources, ${Object.keys(next).length} tracked readings, ${totalChanged} changed${DRY ? " (dry)" : ""}`,
  );
};

main().catch((err) => {
  console.error(`[govt] FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});