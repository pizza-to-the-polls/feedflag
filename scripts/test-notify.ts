/**
 * Regression tests for the notify leg (src/notify/) — issue #56, triple
 * helix pillar 1b (I/O seams).
 *
 * Before #56 both notifiers called `fetch` and read the `settings` singleton
 * inline, so payload shape, channel splitting, and the non-ok rejection
 * paths could not be pinned without network I/O or process.env mutation.
 * The factories now take injectable Settings + an HttpTransport (defaulting
 * to the settings singleton + global fetch), so this suite drives:
 *   - slackFlagChannels split/trim/filter (the bot path's channel loop);
 *   - the Slack bot path (one POST per channel, trimmed channel, text,
 *     unfurl_links: false, Bearer auth, media attachment) and the webhook
 *     fallback (vols webhook preferred, text/username/icon_emoji) for both
 *     notify and postText;
 *   - the transport-failure contract: the notifier still POSTs the FULL
 *     payload before failing, rejects with the exact existing message, and
 *     the pipeline's `.catch(...)` swallow resolves without mutating the
 *     flag;
 *   - the Zapier leg: notify body deep-equals flagPayload(flag) (all fields
 *     incl. the resolved_place diagnostics), postText body { text }, and
 *     the non-ok rejection.
 *
 * The flags here omit `resolvedLocation`, so `placeShowFloor()` (which reads
 * the global settings singleton) never participates — assertions stay
 * deterministic. All fixtures synthetic: invented handles, example.invalid
 * URLs, no real accounts or webhooks.
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38)
 */
import assert from "node:assert/strict";
import { loadSettings, type Settings } from "../src/config.js";
import { createSlackNotifier, flagMediaUrl } from "../src/notify/slack.js";
import { createZapierNotifier } from "../src/notify/zapier.js";
import { flagPayload, flagText } from "../src/notify/format.js";
import type { FlaggedItem, HttpTransport, Notifier } from "../src/types.js";

console.log("notify leg regression tests (issue #56)\n");

/** A synthetic flag — invented handle, example.invalid URL, no
 *  resolvedLocation (so placeShowFloor() never participates). */
function flagFixture(withMedia = true): FlaggedItem {
  const item = {
    id: "synthetic-post-1",
    platform: "instagram" as const,
    authorHandle: "@synthetic-account",
    postedAt: "2026-11-02T15:04:05.000Z",
    caption: "synthetic caption for the fixture post",
    hashtags: ["#synthetic"],
    mediaUrls: withMedia ? ["https://cdn.example.invalid/photo-1.jpg"] : [],
    url: "https://example.invalid/p/1",
    source: "rsshub:instagram:synthetic-account",
  };
  return {
    item,
    description: {
      item,
      caption: item.caption,
      imageDescriptions: ["synthetic image description"],
    },
    classification: {
      relevant: true,
      confidence: 0.9,
      category: "poll_line_report",
      provider: "typesafe/jev-router",
    },
  };
}

// ---------------------------------------------------------------------------
// slackFlagChannels — split / trim / filter (issue #41's loadSettings shape)
// ---------------------------------------------------------------------------
{
  const s = loadSettings({ SLACK_FLAG_CHANNELS: " #a , #b ,,  " });
  assert.deepEqual(
    s.slackFlagChannels,
    ["#a", "#b"],
    "channels are comma-split, trimmed, and empties dropped",
  );
  assert.deepEqual(
    loadSettings({ SLACK_FLAG_CHANNELS: "" }).slackFlagChannels,
    [],
    "an empty string yields no channels",
  );
  assert.deepEqual(
    loadSettings({}).slackFlagChannels,
    [],
    "an unset env var yields no channels",
  );

  console.log("  ✓ slackFlagChannels: split/trim/filter contract");
}

// ---------------------------------------------------------------------------
// Slack bot path — one POST per channel, trimmed channel, media attachment
// ---------------------------------------------------------------------------
{
  const s: Settings = loadSettings({
    SLACK_BOT_TOKEN: "xoxb-synthetic-token",
    SLACK_FLAG_CHANNELS: " #synthetic-channel , #synthetic-digest ",
  });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const notifier: Notifier = createSlackNotifier({ settings: s, transport });

  await notifier.notify(flagFixture(true));
  assert.equal(calls.length, 2, "one POST per flag channel");
  for (const [i, c] of calls.entries()) {
    assert.equal(c.url, "https://slack.com/api/chat.postMessage");
    assert.equal(c.init?.method, "POST");
    const headers = c.init?.headers as Record<string, string>;
    assert.equal(
      headers.authorization,
      "Bearer xoxb-synthetic-token",
      "the bot token rides in the auth header",
    );
    assert.equal(headers["content-type"], "application/json");
    assert.ok(
      c.init?.signal instanceof AbortSignal,
      "the Slack call is bounded by the 15s timeout signal",
    );
    const body = JSON.parse(String(c.init?.body)) as Record<string, unknown>;
    assert.equal(
      body.channel,
      s.slackFlagChannels[i],
      "each channel is passed as-is (already trimmed by loadSettings)",
    );
    assert.equal(
      body.text,
      flagText(flagFixture(true)),
      "the text is the human-facing flagText",
    );
    assert.equal(body.unfurl_links, false);
    assert.equal(
      body.username,
      undefined,
      "the bot path never overrides the name",
    );
    const attachments = body.attachments as { image_url: string }[];
    assert.ok(attachments, "a media flag carries attachments");
    assert.equal(
      attachments[0]!.image_url,
      "https://cdn.example.invalid/photo-1.jpg",
      "the first embeddable image URL is the attachment",
    );
    assert.equal(
      attachments[0]!.color,
      "#E01B5D",
      "the flag color rides on the attachment",
    );
  }

  // flagMediaUrl contract: the first image-y URL wins.
  assert.equal(
    flagMediaUrl(flagFixture(true)),
    "https://cdn.example.invalid/photo-1.jpg",
  );
  assert.equal(flagMediaUrl(flagFixture(false)), undefined);

  console.log(
    "  ✓ slack bot path: one POST per channel, auth header, media attachment, 15s signal",
  );
}

// ---------------------------------------------------------------------------
// Slack webhook path — vols webhook preferred; notify + postText
// ---------------------------------------------------------------------------
{
  const s: Settings = loadSettings({
    SLACK_VOLS_WEBHOOK_URL: "https://hooks.example.invalid/vols",
    SLACK_WEBHOOK_URL: "https://hooks.example.invalid/general",
  });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  const notifier = createSlackNotifier({ settings: s, transport });

  await notifier.notify(flagFixture(false));
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://hooks.example.invalid/vols",
    "the vols webhook is preferred over the general one",
  );
  assert.deepEqual(
    JSON.parse(String(calls[0]!.init?.body)),
    {
      text: flagText(flagFixture(false)),
      username: "feedflag",
      icon_emoji: ":feedflag:",
    },
    "the webhook body carries text/username/icon_emoji",
  );

  // postText rides the same webhook with just the text.
  calls.length = 0;
  await notifier.postText("synthetic post text");
  assert.equal(
    calls[0]!.url,
    "https://hooks.example.invalid/vols",
    "postText also prefers the vols webhook",
  );
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    text: "synthetic post text",
    username: "feedflag",
    icon_emoji: ":feedflag:",
  });

  // Without a vols webhook the general webhook is used.
  calls.length = 0;
  const generalOnly = createSlackNotifier({
    settings: loadSettings({
      SLACK_WEBHOOK_URL: "https://hooks.example.invalid/general",
    }),
    transport,
  });
  await generalOnly.notify(flagFixture(false));
  assert.equal(calls[0]!.url, "https://hooks.example.invalid/general");

  // No delivery configured at all -> the existing error.
  await assert.rejects(
    createSlackNotifier({ settings: loadSettings({}), transport }).notify(
      flagFixture(false),
    ),
    /No Slack delivery configured$/,
    "notify without any Slack config throws the existing error",
  );
  await assert.rejects(
    createSlackNotifier({ settings: loadSettings({}), transport }).postText(
      "t",
    ),
    /No Slack delivery configured for postText$/,
    "postText without any Slack config throws the existing error",
  );

  console.log(
    "  ✓ slack webhook path: vols preferred, webhook body shape, no-config errors",
  );
}

// ---------------------------------------------------------------------------
// Slack transport failure — the post attempt still carries the full payload
// ---------------------------------------------------------------------------
{
  const s: Settings = loadSettings({
    SLACK_BOT_TOKEN: "xoxb-synthetic-token",
    SLACK_FLAG_CHANNELS: "#synthetic-channel",
  });
  const bodies: Record<string, unknown>[] = [];
  const transport: HttpTransport = async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("nope", { status: 500 });
  };
  const notifier = createSlackNotifier({ settings: s, transport });
  const flag = flagFixture(true);

  await assert.rejects(
    notifier.notify(flag),
    (err: Error) => {
      assert.equal(
        err.message,
        "Slack chat.postMessage 500 (ch #synthetic-channel)",
        "the exact existing rejection message",
      );
      return true;
    },
    "a transport failure rejects with the existing contract",
  );
  // The failure did not lose the post ATTEMPT: the full payload was built and
  // POSTed before the non-ok response.
  assert.deepEqual(
    bodies,
    [
      {
        channel: "#synthetic-channel",
        text: flagText(flag),
        unfurl_links: false,
        attachments: [
          {
            color: "#E01B5D",
            fallback: "flagged media",
            image_url: "https://cdn.example.invalid/photo-1.jpg",
          },
        ],
      },
    ],
    "the full payload was still POSTed before the failure",
  );

  // The pipeline's swallow pattern resolves without mutating the flag.
  const before = JSON.stringify(flag);
  await notifier.notify(flag).catch(() => {});
  assert.equal(
    JSON.stringify(flag),
    before,
    "the swallowed failure leaves the flag untouched",
  );

  console.log(
    "  ✓ slack transport failure: full payload POSTed, exact message, swallow resolves",
  );
}

// ---------------------------------------------------------------------------
// Zapier leg — flagPayload body, postText body, non-ok rejection
// ---------------------------------------------------------------------------
{
  const s: Settings = loadSettings({
    ZAPIER_CATCH_URL: "https://hooks.example.invalid/zapier-catch",
  });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  };
  const notifier = createZapierNotifier({ settings: s, transport });
  const flag = flagFixture(true);

  await notifier.notify(flag);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://hooks.example.invalid/zapier-catch");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  assert.deepEqual(
    JSON.parse(String(calls[0]!.init?.body)),
    flagPayload(flag),
    "the notify body is exactly flagPayload(flag) — all fields incl. the resolved_place diagnostics",
  );
  assert.deepEqual(
    JSON.parse(String(calls[0]!.init?.body)).resolved_place,
    "",
    "a flag without resolvedLocation carries an empty resolved_place (floor never consulted)",
  );

  // postText body is just { text }.
  calls.length = 0;
  await notifier.postText("synthetic post text");
  assert.deepEqual(
    JSON.parse(String(calls[0]!.init?.body)),
    { text: "synthetic post text" },
    "postText body is { text }",
  );

  // Non-ok rejection with the exact existing message.
  const failing = createZapierNotifier({
    settings: s,
    transport: async () => new Response("nope", { status: 502 }),
  });
  await assert.rejects(
    failing.notify(flag),
    (err: Error) => {
      assert.equal(err.message, "Zapier catch hook 502: nope");
      return true;
    },
    "a Zapier transport failure rejects with the existing contract",
  );
  await assert.rejects(
    failing.postText("t"),
    (err: Error) => {
      assert.equal(err.message, "Zapier catch hook 502: nope");
      return true;
    },
    "postText rejects with the same contract",
  );
  // The pipeline swallow pattern resolves.
  await failing.notify(flag).catch(() => {});
  await failing.postText("t").catch(() => {});

  // Missing catch URL throws before any transport call.
  let called = false;
  await assert.rejects(
    createZapierNotifier({
      settings: loadSettings({}),
      transport: async () => {
        called = true;
        return new Response("ok", { status: 200 });
      },
    }).notify(flag),
    /ZAPIER_CATCH_URL not configured/,
    "the missing-URL check fires before any transport call",
  );
  assert.equal(called, false, "no transport call was made");

  console.log(
    "  ✓ zapier leg: flagPayload body, postText body, exact rejections, missing-URL guard",
  );
}

console.log("\nAll notify leg regression tests passed.");
