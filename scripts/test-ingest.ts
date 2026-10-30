/**
 * Regression tests for the ingest leg (src/ingest/) — issue #56, triple
 * helix pillar 1b (I/O seams).
 *
 * Coverage pinned here:
 *   - normalizeApifyRecord field picks per platform (instagram / x / tiktok),
 *     including the aiSummary pick from videoMeta.aiVideoDescription and the
 *     aiVideoSummary fallback, the postedAt coercion branches (numeric
 *     seconds vs ms vs ISO string vs missing), and the null record / missing
 *     id drops. Defence-in-depth: no contactInfo/contactName key ever lands
 *     on the produced FeedItem (D6).
 *   - rsshubRoute per platform (handle-encoded) and the site throw; the
 *     handle requirement is pinned at the route/URL level (the pipeline's
 *     own `!s.handle` guard lives in src/pipeline.ts — #57).
 *   - fetchViaRsshub against a fake transport: URL shape, user-agent header,
 *     entry normalization (title+body caption, enclosure image/video, html
 *     <img> fallback, guid/link id), id-less entries filtered, and the
 *     non-ok rejection path.
 *   - fetchSiteReportsSince against a fake paginating transport: the
 *     limit/page query, the `since` client-side filter, the max cap, the
 *     {results}/bare-array tolerance, and the non-ok rejection.
 *   - reportsToObservations: the full crowd Observation shape (schema,
 *     domain crowd, source_ref, platform site, observed_at/posted_at,
 *     location raw/state/county/precinct, signal_kind user_report,
 *     confidence 0.95, provider user-report, relevant) and the D6 PII floor
 *     for the REPORTS leg (contactInfo/contactName never emitted). The
 *     social leg's toObservation D6 is already pinned in
 *     scripts/test-pipeline-pure.ts — not duplicated here.
 *
 * All HTTP fakes are in-memory `Response` objects behind an injected
 * `HttpTransport` — no sockets, no network. Settings mutations (rsshubUrl,
 * pizzabaseUrl) go through the plain mutable settings object in try/finally,
 * never `process.env` (issue #41 house style).
 *
 * All fixtures synthetic: invented handles and post text, example.invalid
 * URLs, invented names/addresses — no real accounts, addresses, or contact
 * info.
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38)
 */
import assert from "node:assert/strict";
import { settings } from "../src/config.js";
import {
  fetchSiteReportsSince,
  reportsToObservations,
} from "../src/ingest/reports.js";
import { fetchViaRsshub, rsshubRoute } from "../src/ingest/rsshub.js";
import { normalizeApifyRecord, runApifyActor } from "../src/ingest/apify.js";
import type { HttpTransport } from "../src/types.js";

console.log("ingest leg regression tests (issue #56)\n");

/** 2026-10-03T15:04:05Z as unix seconds (numeric timestamp fixture). */
const TS_SECONDS = 1791039845;
/** The same instant as unix milliseconds and as an ISO string. Read as
 *  milliseconds instead of seconds, TS_SECONDS would land in year 58725 —
 *  which is the whole reason `postedAt` discriminates on magnitude. */
const TS_MS = TS_SECONDS * 1000;
const TS_ISO = "2026-10-03T15:04:05.000Z";

// ---------------------------------------------------------------------------
// normalizeApifyRecord — instagram field picks
// ---------------------------------------------------------------------------
{
  const item = normalizeApifyRecord(
    {
      id: "ig-1",
      ownerUsername: "synthetic_ig",
      caption: "Lines are long today #synthetic",
      timestamp: TS_SECONDS,
      displayUrl: "https://cdn.example.invalid/ig1.jpg",
      url: "https://example.invalid/p/ig-1",
    },
    "instagram",
    "apify:apify/instagram-scraper",
  );
  assert.ok(item, "a record with an id normalizes");
  assert.equal(item!.id, "ig-1");
  assert.equal(item!.platform, "instagram");
  assert.equal(item!.authorHandle, "synthetic_ig");
  assert.equal(item!.caption, "Lines are long today #synthetic");
  assert.equal(
    item!.postedAt,
    TS_ISO,
    "numeric unix seconds are interpreted as seconds, not ms",
  );
  assert.deepEqual(
    item!.mediaUrls,
    ["https://cdn.example.invalid/ig1.jpg"],
    "displayUrl feeds mediaUrls for instagram",
  );
  assert.equal(item!.videoUrl, undefined);
  assert.equal(item!.url, "https://example.invalid/p/ig-1");
  assert.equal(item!.source, "apify:apify/instagram-scraper");
  // The caption is duplicated before the hashtag scan, so a single hashtag
  // in the text comes back twice. Pinned as-is (seam PR, not a fix).
  assert.deepEqual(item!.hashtags, ["#synthetic", "#synthetic"]);

  console.log(
    "  ✓ normalizeApifyRecord instagram: handle/id/caption/displayUrl/postedAt",
  );
}

// ---------------------------------------------------------------------------
// postedAt's numeric heuristic — seconds vs milliseconds
//
// `postedAt` picks the first of timestamp / createdAt / createdAtMs /
// created_at, then disambiguates a numeric value **by magnitude**, not by
// field name: `ts > 1e12 ? ts : ts * 1000`. Apify actors are inconsistent
// about which unit they emit, and getting this wrong shifts postedAt by 1000x
// either way — which silently reorders runPipeline's newest-first queue and
// corrupts the seen-store's dedupe window. The magnitude rule is therefore
// load-bearing and worth pinning on both sides of the 1e12 boundary.
// ---------------------------------------------------------------------------
{
  const record = (over: Record<string, unknown>) =>
    normalizeApifyRecord(
      { id: "u-1", ownerUsername: "synthetic_ig", caption: "", ...over },
      "instagram",
      "apify:apify/instagram-scraper",
    );

  assert.equal(
    record({ timestamp: TS_SECONDS })!.postedAt,
    TS_ISO,
    "unix seconds below 1e12 are scaled up by 1000",
  );
  assert.equal(
    record({ timestamp: TS_MS })!.postedAt,
    TS_ISO,
    "a timestamp above 1e12 is read as milliseconds, not scaled again",
  );
  assert.equal(
    record({ createdAtMs: TS_MS })!.postedAt,
    TS_ISO,
    "createdAtMs is picked and read as milliseconds",
  );
  assert.equal(
    record({ createdAt: TS_SECONDS, createdAtMs: TS_MS })!.postedAt,
    TS_ISO,
    "the pick order prefers createdAt, and both units agree on the instant",
  );

  // An unparseable string must not emit "Invalid Date" — postedAt falls back
  // to now(), which is still a valid ISO instant the queue can sort on.
  const junk = record({ created_at: "not a date" })!.postedAt;
  assert.ok(
    !Number.isNaN(new Date(junk).getTime()),
    "an unparseable timestamp still yields a valid ISO date",
  );

  console.log(
    "  ✓ postedAt heuristic: seconds scaled, >1e12 read as ms, pick order, junk tolerated",
  );
}

// ---------------------------------------------------------------------------
// normalizeApifyRecord — x (twitter) field picks, incl. the mp4 variant
// ---------------------------------------------------------------------------
{
  const item = normalizeApifyRecord(
    {
      id_str: "x-12345",
      user: { screen_name: "syntheticX" },
      full_text: "Long lines at the synthetic precinct #synthetic",
      created_at: TS_ISO,
      extended_entities: {
        media: [{ media_url_https: "https://cdn.example.invalid/x1.jpg" }],
      },
      video_info: {
        variants: [
          {
            content_type: "application/x-mpegURL",
            url: "https://cdn.example.invalid/x1.m3u8",
          },
          {
            content_type: "video/mp4",
            url: "https://cdn.example.invalid/x1.mp4",
          },
        ],
      },
    },
    "x",
    "apify:knsEor/twitter-scraper",
  );
  assert.ok(item);
  assert.equal(item!.id, "x-12345", "id_str is picked when id is absent");
  assert.equal(item!.authorHandle, "syntheticX", "user.screen_name is picked");
  assert.equal(
    item!.caption,
    "Long lines at the synthetic precinct #synthetic",
  );
  assert.equal(item!.postedAt, TS_ISO, "ISO string timestamps parse");
  assert.deepEqual(
    item!.mediaUrls,
    ["https://cdn.example.invalid/x1.jpg"],
    "extended_entities.media[].media_url_https feeds mediaUrls",
  );
  assert.equal(
    item!.videoUrl,
    "https://cdn.example.invalid/x1.mp4",
    "the first video/mp4 variant is the videoUrl (m3u8 filtered out)",
  );

  console.log(
    "  ✓ normalizeApifyRecord x: nested screen_name/id_str, media + mp4 variant",
  );
}

// ---------------------------------------------------------------------------
// normalizeApifyRecord — tiktok field picks, incl. aiSummary from videoMeta
// ---------------------------------------------------------------------------
{
  const item = normalizeApifyRecord(
    {
      id: "tt-1",
      authorMeta: { uniqueId: "synthetic_tiktok" },
      desc: "Synthetic tiktok caption",
      timestamp: TS_SECONDS,
      mediaUrls: ["https://cdn.example.invalid/tt1.jpg"],
      videoMeta: {
        coverUrl: "https://cdn.example.invalid/tt-cover.jpg",
        aiVideoDescription: "Synthetic AI description of the video.",
      },
      video: { playAddr: "https://cdn.example.invalid/tt1.mp4" },
    },
    "tiktok",
    "apify:clockworks/tiktok-scraper",
  );
  assert.ok(item);
  assert.equal(item!.id, "tt-1");
  assert.equal(item!.authorHandle, "synthetic_tiktok", "uniqueId is picked");
  assert.equal(item!.caption, "Synthetic tiktok caption", "desc is picked");
  assert.deepEqual(
    item!.mediaUrls,
    [
      "https://cdn.example.invalid/tt1.jpg",
      "https://cdn.example.invalid/tt-cover.jpg",
    ],
    "mediaUrls first, then videoMeta.coverUrl (the embeddable cover)",
  );
  assert.equal(
    item!.aiSummary,
    "Synthetic AI description of the video.",
    "aiSummary comes from videoMeta.aiVideoDescription",
  );
  assert.equal(item!.videoUrl, "https://cdn.example.invalid/tt1.mp4");

  // Fallback: aiVideoSummary when aiVideoDescription is absent.
  const item2 = normalizeApifyRecord(
    {
      id: "tt-2",
      authorMeta: { uniqueId: "synthetic_tiktok" },
      desc: "Second synthetic tiktok caption",
      timestamp: TS_SECONDS,
      mediaUrls: [],
      videoMeta: { aiVideoSummary: "Fallback synthetic AI description." },
    },
    "tiktok",
    "apify:clockworks/tiktok-scraper",
  );
  assert.ok(item2);
  assert.equal(
    item2!.aiSummary,
    "Fallback synthetic AI description.",
    "aiVideoSummary is the fallback pick",
  );
  assert.deepEqual(
    item2!.mediaUrls,
    [],
    "no mediaUrls and no coverUrl -> empty array",
  );

  console.log(
    "  ✓ normalizeApifyRecord tiktok: uniqueId/desc/mediaUrls/coverUrl + aiSummary (and fallback)",
  );
}

// ---------------------------------------------------------------------------
// normalizeApifyRecord — drops and edge coercions
// ---------------------------------------------------------------------------
{
  assert.equal(
    normalizeApifyRecord(null, "x", "src"),
    null,
    "a null record normalizes to null",
  );
  assert.equal(
    normalizeApifyRecord({ caption: "no id anywhere" }, "x", "src"),
    null,
    "a record without any id candidate is dropped",
  );

  // A record with no timestamp at all: postedAt defaults to "now" (still ISO).
  const item = normalizeApifyRecord({ id: "no-ts-1" }, "x", "src");
  assert.ok(item);
  assert.match(
    item!.postedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "missing timestamp -> now-ish ISO",
  );
  assert.ok(
    Math.abs(Date.now() - Date.parse(item!.postedAt)) < 60_000,
    "the default timestamp is stamped now-ish",
  );

  // Defence-in-depth (D6): a contactInfo field on the upstream record must
  // never land on the FeedItem.
  const leaky = normalizeApifyRecord(
    {
      id: "leak-1",
      ownerUsername: "synthetic_ig",
      caption: "synthetic caption",
      contactInfo: "phone: 555-0100",
      contactName: "Synthetic Person",
    },
    "instagram",
    "src",
  );
  assert.ok(leaky);
  assert.ok(
    !("contactInfo" in leaky),
    "contactInfo is never copied onto the FeedItem",
  );
  assert.ok(
    !("contactName" in leaky),
    "contactName is never copied onto the FeedItem",
  );
  const flat = JSON.stringify(leaky);
  assert.ok(
    !flat.includes("555-0100") && !flat.includes("Synthetic Person"),
    `no contact data anywhere in the produced item: ${flat}`,
  );

  console.log(
    "  ✓ normalizeApifyRecord: null record + missing id dropped; D6 no-contact keys",
  );
}

// ---------------------------------------------------------------------------
// rsshubRoute — handle encoding + the site throw
// ---------------------------------------------------------------------------
{
  assert.equal(
    rsshubRoute("instagram", "synthetic_ig"),
    "/instagram/user/synthetic_ig",
  );
  assert.equal(rsshubRoute("x", "syntheticX"), "/twitter/user/syntheticX");
  assert.equal(
    rsshubRoute("tiktok", "synthetic_tiktok"),
    "/tiktok/user/synthetic_tiktok",
  );
  assert.equal(
    rsshubRoute("instagram", "a b"),
    "/instagram/user/a%20b",
    "handles are URL-encoded into the route",
  );
  assert.throws(
    () => rsshubRoute("site", "whatever"),
    /site reports are not an RSSHub route/,
    "site reports are the crowd leg, not an RSSHub route",
  );

  console.log(
    "  ✓ rsshubRoute: per-platform paths, handle encoding, site throws",
  );
}

// ---------------------------------------------------------------------------
// fetchViaRsshub — fake transport: URL, headers, entry normalization
// ---------------------------------------------------------------------------
{
  const RSS_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    "<title>synthetic feed</title>",
    "<item>",
    "  <guid>rss-synthetic-1</guid>",
    "  <title>Long line out the door #synthetic</title>",
    "  <description><![CDATA[<p>Synthetic body text &amp; more.</p>]]></description>",
    "  <link>https://example.invalid/p/rss-1</link>",
    "  <pubDate>Mon, 02 Nov 2026 15:04:05 GMT</pubDate>",
    '  <enclosure url="https://cdn.example.invalid/cover.jpg" type="image/jpeg" length="1000"/>',
    "</item>",
    "<item>",
    "  <guid>rss-synthetic-2</guid>",
    "  <title>Video clip</title>",
    '  <description><![CDATA[Plain body text with an inline img: <img src="https://cdn.example.invalid/inline.png" />.]]></description>',
    "  <link>https://example.invalid/p/rss-2</link>",
    "  <pubDate>Mon, 02 Nov 2026 15:05:05 GMT</pubDate>",
    '  <enclosure url="https://cdn.example.invalid/clip.mp4" type="video/mp4" length="2000"/>',
    "</item>",
    "<item>",
    "  <title>Id-less entry</title>",
    "  <description><![CDATA[Body only]]></description>",
    "  <pubDate>Mon, 02 Nov 2026 15:06:05 GMT</pubDate>",
    "</item>",
    "</channel></rss>",
  ].join("\n");

  const savedUrl = settings.rsshubUrl;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    return new Response(RSS_XML, {
      headers: { "content-type": "application/rss+xml" },
    });
  };
  try {
    settings.rsshubUrl = "https://rsshub.example.invalid";

    const items = await fetchViaRsshub(
      "instagram",
      "synthetic_ig",
      "rsshub:instagram:synthetic_ig",
      20,
      transport,
    );
    // URL: settings.rsshubUrl + the route + ?limit= — the handle requirement
    // is pinned at the URL level.
    assert.equal(calls.length, 1, "one request per fetch");
    assert.equal(
      calls[0]!.url,
      "https://rsshub.example.invalid/instagram/user/synthetic_ig?limit=20",
    );
    assert.equal(
      (calls[0]!.init?.headers as Record<string, string>)["user-agent"],
      "feedflag/0.1 (+https://github.com/duncombe/feedflag)",
      "the RSSHub request carries the feedflag user-agent",
    );

    assert.equal(items.length, 2, "the id-less entry is dropped");
    const [first, second] = items;

    // Entry 1: title+body caption, enclosure image, guid id.
    assert.equal(first!.id, "rss-synthetic-1");
    assert.equal(first!.platform, "instagram");
    assert.equal(first!.authorHandle, "synthetic_ig");
    assert.equal(
      first!.caption,
      "Long line out the door #synthetic\nSynthetic body text & more.",
      "caption = html-stripped title + body; CDATA entities are decoded",
    );
    assert.deepEqual(
      first!.hashtags,
      ["#synthetic"],
      "hashtags are scanned once over title+body (no duplication here)",
    );
    assert.deepEqual(
      first!.mediaUrls,
      ["https://cdn.example.invalid/cover.jpg"],
      "the image enclosure feeds mediaUrls",
    );
    assert.equal(first!.videoUrl, undefined);
    assert.equal(first!.url, "https://example.invalid/p/rss-1");
    assert.equal(first!.postedAt, "2026-11-02T15:04:05.000Z");

    // Entry 2: no image enclosure -> the html <img> fallback; video enclosure.
    assert.equal(second!.id, "rss-synthetic-2");
    assert.deepEqual(
      second!.mediaUrls,
      ["https://cdn.example.invalid/inline.png"],
      "no image enclosure -> the first <img> in the html is used",
    );
    assert.equal(
      second!.videoUrl,
      "https://cdn.example.invalid/clip.mp4",
      "the video enclosure feeds videoUrl",
    );

    // A custom limit changes the query string.
    calls.length = 0;
    await fetchViaRsshub("x", "syntheticX", "src", 5, transport);
    assert.equal(
      calls[0]!.url,
      "https://rsshub.example.invalid/twitter/user/syntheticX?limit=5",
    );

    // Non-ok rejects with the existing message (status + full URL).
    await assert.rejects(
      fetchViaRsshub("tiktok", "synthetic_tiktok", "src", 20, async () => {
        return new Response("nope", { status: 500 });
      }),
      (err: Error) => {
        assert.equal(
          err.message,
          "RSSHub 500 https://rsshub.example.invalid/tiktok/user/synthetic_tiktok?limit=20",
        );
        return true;
      },
      "non-ok responses reject with the RSSHub error contract",
    );
  } finally {
    settings.rsshubUrl = savedUrl;
  }
  assert.equal(settings.rsshubUrl, savedUrl, "settings restored");

  console.log(
    "  ✓ fetchViaRsshub: URL/user-agent contract, entry normalization, id-less filter, non-ok rejects",
  );
}

// ---------------------------------------------------------------------------
// fetchSiteReportsSince — fake paginating transport
// ---------------------------------------------------------------------------
{
  const since = "2026-11-02T09:00:00.000Z";
  const pageReports = (id: number, createdAt: string) => ({
    id,
    createdAt,
    reportURL: `https://example.invalid/reports/${id}`,
    waitTime: null,
  });

  // Page 0: two fresh reports (both strictly after `since`).
  // Page 1: one fresh (09:45 > 09:00) + one older than `since` -> the loop
  // stops here.
  const pages: Record<number, unknown> = {
    0: [
      pageReports(1, "2026-11-02T10:00:00Z"),
      pageReports(2, "2026-11-02T09:30:00Z"),
    ],
    1: [
      pageReports(3, "2026-11-02T09:45:00Z"),
      pageReports(4, "2026-11-01T09:00:00Z"),
    ],
  };
  const urls: string[] = [];
  const auths: (string | undefined)[] = [];
  const transport: HttpTransport = async (url, init) => {
    urls.push(url);
    auths.push((init?.headers as Record<string, string>)?.authorization);
    const page = Number(new URL(url).searchParams.get("page"));
    const body = pages[page];
    if (body === undefined) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };

  const savedUrl = settings.pizzabaseUrl;
  const savedKey = settings.pizzabaseKey;
  try {
    settings.pizzabaseUrl = "https://pizzabase.example.invalid";
    settings.pizzabaseKey = "synthetic-machine-token";

    // Basic auth header: pizzabase checkAuthorization strips the "Basic "
    // prefix, so the key rides as `Basic <key>` (source docblock).
    const out = await fetchSiteReportsSince(since, 50, transport);
    assert.deepEqual(
      urls,
      [
        "https://pizzabase.example.invalid/reports?limit=100&page=0",
        "https://pizzabase.example.invalid/reports?limit=100&page=1",
      ],
      "pages back from newest with the limit=100&page=N query",
    );
    assert.ok(
      auths.every((a) => a === "Basic synthetic-machine-token"),
      "the machine token rides as a Basic authorization header",
    );
    assert.deepEqual(
      out.map((r) => r.id),
      [1, 2, 3],
      "fresh reports collected; the page containing an old report stops the walk",
    );

    // max caps the output even when more fresh rows exist.
    urls.length = 0;
    const capped = await fetchSiteReportsSince(since, 2, transport);
    assert.deepEqual(
      capped.map((r) => r.id),
      [1, 2],
      "out.length >= max stops the walk and slice(0, max) caps the output",
    );

    // {results} envelope and a bare array are both tolerated. Both fakes are
    // page-aware and return an empty page after page 0, exactly like the real
    // API ending: a transport that returned the same non-empty page forever
    // would walk all ten pages and collect the report ten times, which tests
    // the pagination loop rather than the envelope parsing claimed here.
    const firstPageOnly =
      (body: (page: number) => unknown): HttpTransport =>
      async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(JSON.stringify(body(page)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

    const envelopeTransport = firstPageOnly((page) =>
      page === 0
        ? { results: [pageReports(9, "2026-11-02T10:00:00Z")] }
        : { results: [] },
    );
    const fromEnvelope = await fetchSiteReportsSince(
      since,
      50,
      envelopeTransport,
    );
    assert.deepEqual(
      fromEnvelope.map((r) => r.id),
      [9],
      "{results} envelope tolerated",
    );

    const bareTransport = firstPageOnly((page) =>
      page === 0 ? [pageReports(11, "2026-11-02T10:00:00Z")] : [],
    );
    const fromBare = await fetchSiteReportsSince(since, 50, bareTransport);
    assert.deepEqual(
      fromBare.map((r) => r.id),
      [11],
      "bare array tolerated",
    );

    // An empty first page stops immediately (no second request).
    const emptyTransport: HttpTransport = async () =>
      new Response("[]", { status: 200 });
    assert.deepEqual(
      await fetchSiteReportsSince(since, 50, emptyTransport),
      [],
      "an empty page ends the walk with no reports",
    );

    // Non-ok rejects with the existing message.
    await assert.rejects(
      fetchSiteReportsSince(
        since,
        50,
        async () => new Response("no", { status: 500 }),
      ),
      (err: Error) => {
        assert.match(err.message, /pizzabase \/reports 500/);
        return true;
      },
      "non-ok responses reject with the pizzabase error contract",
    );
  } finally {
    settings.pizzabaseUrl = savedUrl;
    settings.pizzabaseKey = savedKey;
  }
  assert.equal(settings.pizzabaseUrl, savedUrl, "settings restored");
  assert.equal(settings.pizzabaseKey, savedKey, "settings restored");

  console.log(
    "  ✓ fetchSiteReportsSince: paging + since filter + max cap, envelope/bare tolerance, non-ok rejects",
  );
}

// ---------------------------------------------------------------------------
// reportsToObservations — the crowd Observation shape + the D6 PII floor
// ---------------------------------------------------------------------------
{
  const report = {
    id: 7,
    createdAt: "2026-11-02T12:00:00.000Z",
    reportURL: "https://example.invalid/reports/7",
    // Deliberately null so the LLM wait normalizer is never invoked — the
    // suite stays network-free (reports only normalize when waitTime is set).
    waitTime: null,
    // D6 leak candidates: never allowed into the emitted record.
    contactInfo: "phone: 555-0100, email: leak@example.invalid",
    contactName: "Synthetic Person",
    location: {
      id: 42,
      name: "Synthetic Recreation Center",
      city: "Synthetic City",
      state: "ST",
      address: "123 Synthetic St",
      fullAddress: "123 Synthetic St, Synthetic City, ST",
    },
  };
  const [obs] = await reportsToObservations([report]);

  assert.ok(obs, "one report -> one observation");
  assert.equal(obs!.schema, "feedflag/observation@1");
  assert.equal(obs!.domain, "crowd", "reports are the crowd leg");
  assert.equal(obs!.source_ref, "pizzabase:reports/7");
  assert.equal(obs!.url, "https://example.invalid/reports/7");
  assert.equal(obs!.platform, "site");
  assert.equal(obs!.observed_at, "2026-11-02T12:00:00.000Z");
  assert.equal(obs!.posted_at, "2026-11-02T12:00:00.000Z");
  assert.deepEqual(
    obs!.location,
    {
      raw: "123 Synthetic St, Synthetic City, ST",
      state: "ST",
      county: "Synthetic City",
      precinct: "Synthetic Recreation Center",
    },
    "location: raw ← fullAddress, state, county ← city, precinct ← name",
  );
  assert.equal(obs!.signal_kind, "user_report");
  assert.equal(
    obs!.wait_minutes,
    undefined,
    "no waitTime -> no wait extraction (the normalizer is never invoked)",
  );
  assert.equal(obs!.wait_category, undefined);
  assert.equal(obs!.confidence, 0.95, "reports are ground truth: 0.95");
  assert.equal(obs!.provider, "user-report", "no classifier in the loop");
  assert.equal(obs!.relevant, true, "crowd rows are always relevant (D4)");

  // The description set passthrough.
  assert.equal(obs!.description.item.id, "7");
  assert.equal(obs!.description.item.platform, "site");
  assert.equal(obs!.description.item.authorHandle, "site-reporter");
  assert.equal(
    obs!.description.item.caption,
    'User report: waitTime=""',
    "no waitTime -> the caption shows the empty value, not undefined",
  );
  assert.equal(
    obs!.description.caption,
    "User-submitted report. Wait time (free text): (none)",
  );
  assert.deepEqual(obs!.description.imageDescriptions, []);

  // D6 PII floor (reports leg): the contactInfo/contactName values that rode
  // on the upstream report must never appear anywhere in the emitted record.
  assert.ok(!("contactInfo" in obs!), "no contactInfo key on the record");
  assert.ok(!("contactName" in obs!), "no contactName key on the record");
  const flat = JSON.stringify(obs);
  assert.ok(
    !flat.includes("555-0100") &&
      !flat.includes("leak@example.invalid") &&
      !flat.includes("Synthetic Person"),
    `no contact data anywhere in the emitted observation: ${flat}`,
  );

  console.log(
    "  ✓ reportsToObservations: full crowd Observation shape + D6 PII floor (reports leg)",
  );
}

// ---------------------------------------------------------------------------
// runApifyActor — the transport seam (missing token throws first)
// ---------------------------------------------------------------------------
{
  const savedToken = settings.apifyToken;
  try {
    settings.apifyToken = "";
    await assert.rejects(
      runApifyActor("apify/instagram-scraper", {}, async () => {
        throw new Error("transport must not be called");
      }),
      /APIFY_API_TOKEN not configured/,
      "the missing-token check fires before any transport call",
    );
  } finally {
    settings.apifyToken = savedToken;
  }
  assert.equal(settings.apifyToken, savedToken, "settings restored");

  console.log(
    "  ✓ runApifyActor: the missing-token guard fires before any transport call",
  );
}

console.log("\nAll ingest leg regression tests passed.");
