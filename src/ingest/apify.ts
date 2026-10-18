import type { FeedItem, Platform } from "../types.js";
import { settings } from "../config.js";

/**
 * Apify ingestion: run an actor synchronously and read its dataset items.
 * Actors used per platform (all pay-per-result, see README cost table):
 *   instagram: apify/instagram-scraper
 *   x:         knsEor/twitter-scraper  (or apify/twitter-scraper)
 *   tiktok:    clockworks/tiktok-scraper
 */
export async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
): Promise<any[]> {
  if (!settings.apifyToken) throw new Error("APIFY_API_TOKEN not configured");
  // API v2 URLs use `username~actor-name`; feeds.json uses the catalog's
  // `username/actor-name` form — translate, or the path 404s.
  const actorPath = actorId.replace("/", "~");
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(settings.apifyToken)}&timeout=300`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify ${actorId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as any[];
}

function pick(...vals: unknown[]): any {
  return vals.find((v) => v != null && v !== "") ?? undefined;
}

function arr(x: any): any[] {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function mediaUrls(r: any, platform: Platform): string[] {
  switch (platform) {
    case "instagram": {
      const images = arr(pick(r.images, r.displayUrl ? [r.displayUrl] : undefined));
      return images.filter((u) => typeof u === "string");
    }
    case "x": {
      const media = [...arr(pick(r.extended_entities?.media, r.entities?.media))];
      return media
        .map((m: any) => pick(m?.media_url_https, m?.media_url))
        .filter((u: any) => typeof u === "string");
    }
    case "tiktok": {
      const covers = arr(pick(r.covers, r.surcover ? [r.surcover] : undefined));
      return covers
        .map((c: any) => pick(typeof c === "string" ? c : c?.url, typeof c === "string" ? c : c?.webUrl))
        .filter((u: any) => typeof u === "string");
    }
    case "site":
      return [];
  }
}

function videoUrl(r: any, platform: Platform): string | undefined {
  const xVariant = arr(r?.video_info?.variants)
    .filter((v: any) => v?.content_type === "video/mp4")
    .map((v: any) => v?.url)[0];
  return pick(
    platform === "tiktok" ? r?.video?.playAddr ?? r?.video?.downloadAddr : undefined,
    r?.videoUrl,
    r?.video?.playUrl,
    xVariant,
  );
}

function postedAt(r: any): string {
  const ts = pick(r.timestamp, r.createdAt, r.createdAtMs, r.created_at);
  if (typeof ts === "number") {
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof ts === "string") {
    const t = new Date(ts);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Dataset record -> FeedItem. Field names vary per actor (and per actor
 * version) — these picks cover the commonly seen layouts. Run once against
 * real data with --dry-run and adjust here if something comes back empty.
 */
export function normalizeApifyRecord(
  r: any,
  platform: Platform,
  source: string,
): FeedItem | null {
  if (!r) return null;
  const handle = String(
    pick(
      r.ownerUsername,
      r.username,
      r.user?.username,
      r.authorMeta?.uniqueId,
      r.authorMeta?.name,
      r.author?.unique_id ?? r.author?.uniqueId,
      r.author?.uniqueId,
      r.author?.name,
      "unknown",
  ),
  );
  const id = pick(r.id, r.id_str, r.pk, r.postId, r.shortcode, r.webUrl, r.url, r.shareUrl);
  if (!id) return null;
  const caption = String(pick(r.caption, r.full_text, r.text, r.title, r.desc, ""));
  const url = pick(r.url, r.webUrl, r.shareUrl, r.externalUrl, r.link);
  return {
    id: String(id),
    platform,
    authorHandle: handle,
    postedAt: postedAt(r),
    caption,
    hashtags: [...`${caption} ${caption}`.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0]),
    url: typeof url === "string" ? url : undefined,
    mediaUrls: mediaUrls(r, platform),
    videoUrl: videoUrl(r, platform),
    source,
  };
}