/**
 * Regression tests for the describe leg (src/describe/openrouter.ts) —
 * issue #56, triple helix pillar 1b (I/O seams).
 *
 * Before #56 `toDataUrl`/`frameFromVideo` hit `fetch` directly, so the media
 * leg of `describeItem` could not be driven without network I/O (the
 * `BLOCKED(#56)` marker in scripts/test-classify.ts). The seam threads an
 * `HttpTransport` (defaulting to global fetch) through every media fetch and
 * every openrouterChat call, so this suite:
 *   - pins the request shape (model, messages, image_url data URL, auth
 *     header, hard timeout signal);
 *   - pins the response -> DescriptionSet mapping (item passthrough,
 *     caption, imageDescriptions, videoSummary);
 *   - pins the image precedence (a mediaUrls post never fetches its
 *     videoUrl — no ffmpeg needed);
 *   - pins the aiSummary append (actor-provided AI video description) and
 *     its videoSummary wording;
 *   - asserts the STRINGS-ONLY rule: the description set is text-only, so no
 *     image data (data:/base64) may ride along (JEV is text-only);
 *   - drives the media-fetch failure paths (non-ok, non-image content-type)
 *     that throw fast — which is what the pipeline's `.catch(() => null)`
 *     is for (the post continues caption-only).
 *
 * Not covered here (follow-up): the openrouterChat caption-failure placeholder
 * path retries once with a 25s backoff — driving it in a unit test would
 * sleep 25s; a timer seam is a future change. The ffmpeg frame-extraction
 * path (frameFromVideo) needs ffmpeg on PATH; the image-precedence and
 * aiSummary cases cover the video branch without it.
 *
 * All HTTP fakes are in-memory `Response` objects behind an injected
 * `HttpTransport` — no sockets, no network. All fixtures synthetic:
 * invented handles, example.invalid URLs, no real accounts.
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38)
 */
import assert from "node:assert/strict";
import { loadSettings } from "../src/config.js";
import { describeItem } from "../src/describe/openrouter.js";
import type { FeedItem, HttpTransport } from "../src/types.js";

console.log("describe leg regression tests (issue #56)\n");

/** Injected settings — synthetic key/model, no real credential. */
const TEST_SETTINGS = loadSettings({
  OPENROUTER_API_KEY: "sk-synthetic-test",
  VISION_MODEL: "test-vision",
});

/** The OpenRouter chat completions URL — where the caption call goes. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** JPEG magic bytes — enough for the content-type contract to be exercised. */
const MEDIA_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const MEDIA_DATA_URL = `data:image/jpeg;base64,${Buffer.from(MEDIA_BYTES).toString("base64")}`;

/** The synthetic caption the fake transport returns. */
const CAPTION = "Synthetic caption: a queue of synthetic people outside.";

/** A fake transport that routes by URL: media URLs -> an image/jpeg
 *  response; the OpenRouter URL -> the caption JSON. Every call is recorded
 *  so assertions can pin exactly what was fetched (and what was NOT). */
function makeTransport(mediaBytes = MEDIA_BYTES): {
  transport: HttpTransport;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (url === OPENROUTER_URL) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: CAPTION } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(mediaBytes, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  };
  return { transport, calls };
}

/** A synthetic FeedItem fixture — invented handle, example.invalid URLs. */
function itemFixture(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "synthetic-post-1",
    platform: "instagram",
    authorHandle: "@synthetic-account",
    postedAt: "2026-11-02T15:04:05.000Z",
    caption: "synthetic caption for the fixture post",
    hashtags: ["#synthetic"],
    mediaUrls: [],
    url: "https://example.invalid/p/1",
    source: "rsshub:instagram:synthetic-account",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Request shape + response -> DescriptionSet mapping (image post)
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: ["https://cdn.example.invalid/photo-1.jpg"],
  });
  const { transport, calls } = makeTransport();
  const set = await describeItem(item, TEST_SETTINGS, transport);

  // Exactly two transport calls: the media fetch, then the caption call.
  assert.equal(calls.length, 2, "media fetch + one caption call");
  assert.equal(
    calls[0]!.url,
    "https://cdn.example.invalid/photo-1.jpg",
    "the image URL is fetched first",
  );
  assert.equal(
    calls[0]!.init,
    undefined,
    "the media fetch carries no init (a plain GET, matching the original fetch(url) call)",
  );
  assert.equal(calls[1]!.url, OPENROUTER_URL);
  assert.equal(calls[1]!.init?.method, "POST");

  // Request shape: model, messages, image_url data URL, auth, timeout signal.
  const body = JSON.parse(String(calls[1]!.init?.body)) as {
    model: string;
    max_tokens: number;
    messages: {
      role: string;
      content: unknown;
    }[];
  };
  assert.equal(
    body.model,
    "test-vision",
    "the vision model rides from settings",
  );
  assert.equal(body.max_tokens, 220);
  assert.equal(body.messages.length, 2);
  assert.equal(
    body.messages[0]!.role,
    "system",
    "the descriptive-only system prompt comes first",
  );
  assert.match(
    String(body.messages[0]!.content),
    // Case-insensitive on purpose: SYSTEM_PROMPT is a joined array of
    // sentences, so "No names…" is capitalised by position. What must not
    // drift is the privacy rule itself, not its casing.
    /no names, no face identification/i,
    "the system prompt is the descriptive-only one (no faces/speculation)",
  );
  assert.equal(body.messages[1]!.role, "user");
  const content = body.messages[1]!.content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  assert.equal(content.length, 2, "text + image_url blocks");
  assert.deepEqual(content[0], { type: "text", text: "Caption this image." });
  assert.equal(content[1]!.type, "image_url");
  assert.equal(
    content[1]!.image_url!.url,
    MEDIA_DATA_URL,
    "the media bytes are inlined as the data URL",
  );
  const headers = calls[1]!.init?.headers as Record<string, string>;
  assert.equal(
    headers.authorization,
    "Bearer sk-synthetic-test",
    "the injected settings key rides in the auth header",
  );
  assert.equal(headers["content-type"], "application/json");
  assert.ok(
    calls[1]!.init?.signal instanceof AbortSignal,
    "the caption call is bounded by the 120s hard timeout signal",
  );

  // Response -> DescriptionSet mapping.
  assert.equal(set.item, item, "the item passes through by reference");
  assert.equal(set.caption, item.caption, "caption = the author text");
  assert.deepEqual(
    set.imageDescriptions,
    [CAPTION],
    "one vision caption per fetched image",
  );
  assert.equal(
    set.videoSummary,
    undefined,
    "an image post is not a video post",
  );
  assert.ok(!("evidence" in set), "social-leg descriptions carry no evidence");

  console.log(
    "  ✓ describeItem: request shape (model/messages/data URL/auth) + DescriptionSet mapping",
  );
}

// ---------------------------------------------------------------------------
// Image precedence: a mediaUrls post never fetches its videoUrl
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: ["https://cdn.example.invalid/photo-1.jpg"],
    videoUrl: "https://cdn.example.invalid/video-1.mp4",
  });
  const { transport, calls } = makeTransport();
  const set = await describeItem(item, TEST_SETTINGS, transport);

  const fetchedUrls = calls.map((c) => c.url);
  assert.ok(
    !fetchedUrls.includes("https://cdn.example.invalid/video-1.mp4"),
    "the videoUrl is never fetched when mediaUrls is non-empty (image precedence)",
  );
  assert.deepEqual(
    set.imageDescriptions,
    [CAPTION],
    "one caption for the image",
  );
  assert.equal(
    set.videoSummary,
    "Video post; first frame captioned above.",
    "the post is still marked as a video (videoUrl set)",
  );

  console.log(
    "  ✓ describeItem: image precedence — videoUrl never fetched when mediaUrls is non-empty",
  );
}

// ---------------------------------------------------------------------------
// aiSummary: actor-provided AI video description, no media at all
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: [],
    aiSummary: "Synthetic AI description of the video.",
  });
  const { transport, calls } = makeTransport();
  const set = await describeItem(item, TEST_SETTINGS, transport);

  assert.equal(calls.length, 0, "no media -> no transport calls at all");
  assert.deepEqual(
    set.imageDescriptions,
    ["[AI video description] Synthetic AI description of the video."],
    "the aiSummary is appended as text evidence",
  );
  assert.equal(
    set.videoSummary,
    "Video post; AI description above.",
    "the aiSummary post is marked as a video",
  );

  console.log(
    "  ✓ describeItem: aiSummary appended as text evidence; no media -> no transport calls",
  );
}

// ---------------------------------------------------------------------------
// Strings-only rule: the description set carries text, never image data
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: [
      "https://cdn.example.invalid/photo-1.jpg",
      "https://cdn.example.invalid/photo-2.jpg",
    ],
    aiSummary: "Synthetic AI description of the video.",
  });
  const { transport, calls } = makeTransport();
  const set = await describeItem(item, TEST_SETTINGS, transport);

  // describeItem fetches each media URL (toDataUrl) and then captions each
  // resulting source (captionDataUrl -> openrouterChat), so two images cost
  // four transport calls, not three. Same loop shape as main; the seam only
  // threaded the transport through it.
  assert.equal(
    calls.length,
    4,
    "two image fetches + one caption call per image",
  );
  for (const [i, d] of set.imageDescriptions.entries()) {
    assert.equal(
      typeof d,
      "string",
      `imageDescriptions[${i}] must be a string (Jev is text-only)`,
    );
  }
  assert.equal(typeof set.caption, "string");
  assert.equal(
    typeof set.videoSummary,
    "string",
    "videoSummary, when present, is a string",
  );
  const flat = JSON.stringify(set);
  assert.ok(
    !flat.includes("data:image") && !flat.includes("base64"),
    "the description set must never carry image data (strings only)",
  );

  console.log(
    "  ✓ describeItem: strings-only rule — no data:/base64 payload in the set",
  );
}

// ---------------------------------------------------------------------------
// Media-fetch failures -> describeItem rejects (the pipeline's .catch -> null)
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: ["https://cdn.example.invalid/photo-1.jpg"],
  });

  // Non-ok media fetch: toDataUrl throws — the throw that triggers the
  // pipeline's `.catch(() => null)` (the post continues caption-only there).
  await assert.rejects(
    describeItem(item, TEST_SETTINGS, async (url) => {
      if (url === OPENROUTER_URL) {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return new Response("gone", { status: 500 });
    }),
    (err: Error) => {
      assert.match(
        err.message,
        /media fetch 500 for https:\/\/cdn\.example\.invalid\/photo-1\.jpg/,
      );
      return true;
    },
    "a non-ok media fetch rejects with the existing message",
  );

  // A non-image content-type is refused too (never feed a non-image to vision).
  await assert.rejects(
    describeItem(item, TEST_SETTINGS, async (url) => {
      if (url === OPENROUTER_URL) {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
    (err: Error) => {
      assert.match(err.message, /non-image content-type text\/html/);
      return true;
    },
    "a non-image content-type rejects",
  );

  // The pipeline pattern: .catch(() => null) turns the throw into null so the
  // run continues (the degradation the pipeline relies on).
  const nulled = await describeItem(item, TEST_SETTINGS, async (url) => {
    if (url === OPENROUTER_URL) {
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }
    return new Response("gone", { status: 500 });
  }).catch(() => null);
  assert.equal(nulled, null, ".catch(() => null) degrades to null");

  console.log(
    "  ✓ describeItem: media-fetch failures reject with the existing contract; .catch(() => null) degrades",
  );
}

// ---------------------------------------------------------------------------
// Missing key: the media fetch still happens, OpenRouter is never reached, and
// the caption degrades to the placeholder instead of dropping the post
// ---------------------------------------------------------------------------
{
  const item = itemFixture({
    mediaUrls: ["https://cdn.example.invalid/photo-1.jpg"],
  });
  const calledUrls: string[] = [];
  // describeItem does NOT reject here. `openrouterChat` throws
  // "OPENROUTER_API_KEY not configured" inside `captionDataUrl`, but the
  // caption loop's try/catch substitutes the placeholder — the same one that
  // covers any other caption failure, and the same shape as main. A missing
  // key therefore degrades the description rather than losing the post.
  const set = await describeItem(
    item,
    loadSettings({ OPENROUTER_API_KEY: "", VISION_MODEL: "test-vision" }),
    async (url) => {
      calledUrls.push(url);
      if (url === OPENROUTER_URL) {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return new Response(MEDIA_BYTES, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    },
  );
  assert.deepEqual(
    set.imageDescriptions,
    ["(image present, caption unavailable)"],
    "a missing key degrades to the placeholder caption instead of throwing",
  );
  assert.deepEqual(
    calledUrls,
    ["https://cdn.example.invalid/photo-1.jpg"],
    "the media fetch happens first; the OpenRouter endpoint is never reached",
  );

  console.log(
    "  ✓ describeItem: missing key degrades to the placeholder caption, OpenRouter never called",
  );
}

console.log("\nAll describe leg regression tests passed.");
