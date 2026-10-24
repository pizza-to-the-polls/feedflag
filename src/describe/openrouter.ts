import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../config.js";
import type { DescriptionSet, FeedItem } from "../types.js";

const run = promisify(execFile);

const SYSTEM_PROMPT = [
  "You caption social-media imagery for a downstream text-only classifier.",
  "Describe only what is visible: scene, objects, on-screen text, people's actions, anything unusual.",
  "No names, no face identification, no speculation, no opinions.",
  "Answer in 2-3 short factual sentences.",
].join(" ");

export async function openrouterChat(
  body: Record<string, unknown>,
): Promise<string> {
  if (!settings.openrouterKey)
    throw new Error("OPENROUTER_API_KEY not configured");
  let lastErr: unknown;
  // 2 attempts with backoff — upstream providers rate-limit bursty small calls
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.openrouterKey}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://github.com/pizza-to-the-polls/feedflag",
          "X-Title": "feedflag",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 25000));
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `OpenRouter ${JSON.stringify(body.model)} ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      }
      const j: any = await res.json();
      return j.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      lastErr = err;
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 25000));
    }
  }
  throw lastErr ?? new Error("openrouterChat failed");
}

async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`media fetch ${res.status} for ${url.slice(0, 120)}`);
  const ct = res.headers.get("content-type") ?? "image/jpeg";
  if (!ct.startsWith("image/")) throw new Error(`non-image content-type ${ct}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:${ct};base64,${b64}`;
}

/** Pull one representative frame out of a video via ffmpeg (must be on PATH). */
async function frameFromVideo(videoUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feedflag-"));
  try {
    const input = join(dir, "in.video");
    const frame = join(dir, "frame.jpg");
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`video fetch ${res.status}`);
    await writeFile(input, Buffer.from(await res.arrayBuffer()));
    await run("ffmpeg", [
      "-y",
      "-i",
      input,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      frame,
    ]);
    const b64 = (await readFile(frame)).toString("base64");
    return `data:image/jpeg;base64,${b64}`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function captionDataUrl(dataUrl: string): Promise<string> {
  return openrouterChat({
    model: settings.visionModel,
    max_tokens: 220,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Caption this image." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
}

/**
 * Build the JEV-ready description set for one post: author text + one vision
 * caption per image (videos -> first frame). JEV is text-only, so this is the
 * media leg of the pipeline.
 */
export async function describeItem(item: FeedItem): Promise<DescriptionSet> {
  const sources: string[] = [];
  for (const u of item.mediaUrls.slice(0, 4)) {
    sources.push(await toDataUrl(u));
  }
  if (sources.length === 0 && item.videoUrl) {
    try {
      sources.push(await frameFromVideo(item.videoUrl));
    } catch (err) {
      console.warn(
        `[feedflag] video frame failed ${item.id}: ${String(err).slice(0, 120)}`,
      );
    }
  }
  const imageDescriptions: string[] = [];
  for (const s of sources) {
    try {
      imageDescriptions.push(await captionDataUrl(s));
    } catch (err) {
      console.warn(
        `[feedflag] caption failed ${item.id}: ${String(err).slice(0, 120)}`,
      );
      imageDescriptions.push("(image present, caption unavailable)");
    }
  }
  // Actor-provided AI video description (e.g. clockworks videoMeta): text
  // evidence without vision captioning — append to the description set.
  if (item.aiSummary)
    imageDescriptions.push(`[AI video description] ${item.aiSummary}`);
  return {
    item,
    caption: item.caption,
    imageDescriptions,
    videoSummary: item.videoUrl
      ? "Video post; first frame captioned above."
      : item.aiSummary
        ? "Video post; AI description above."
        : undefined,
  };
}
