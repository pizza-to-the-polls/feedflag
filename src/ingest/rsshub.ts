import { XMLParser } from "fast-xml-parser";
import type { FeedItem, Platform } from "../types.js";
import { settings } from "../config.js";

/**
 * Generic RSS/Atom reader for RSSHub routes:
 *   /instagram/user/:handle
 *   /twitter/user/:handle   (X)
 *   /tiktok/user/:handle
 *
 * RSSHub turns platform pages into feeds; we just need images + text out.
 */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function firstImageInHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const srcs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  return srcs.find((u) => /\.(jpe?g|png|webp)([?#]|$)/i.test(u)) ?? srcs[0];
}

function enclosure(e: any, typeRe: RegExp): string | undefined {
  return toArray(e?.enclosure).find(
    (enc: any) => typeof enc?.url === "string" && typeRe.test(enc?.type ?? ""),
  )?.url;
}

function entryLink(e: any): string | undefined {
  const l = e?.link;
  if (typeof l === "string") return l;
  return toArray(l).find((x: any) => !x?.rel || x.rel === "alternate")?.href ?? e?.url;
}

export function rsshubRoute(platform: Platform, handle: string): string {
  switch (platform) {
    case "instagram":
      return `/instagram/user/${encodeURIComponent(handle)}`;
    case "x":
      return `/twitter/user/${encodeURIComponent(handle)}`;
    case "tiktok":
      return `/tiktok/user/${encodeURIComponent(handle)}`;
    case "site":
      throw new Error("site reports are not an RSSHub route (see src/ingest/reports.ts)");
  }
}

function toFeedItem(e: any, platform: Platform, handle: string, source: string): FeedItem | null {
  const id = e?.guid ?? e?.id ?? entryLink(e);
  if (!id) return null;
  const html =
    typeof e?.description === "string" ? e.description : typeof e?.summary === "string" ? e.summary : "";
  const title = stripHtml(typeof e?.title === "string" ? e.title : "");
  const body = stripHtml(html);
  const img = enclosure(e, /^image\//) ?? firstImageInHtml(html);
  const video = enclosure(e, /^video\//);
  const postedRaw = e?.pubDate ?? e?.published ?? e?.updated;
  const postedAt = postedRaw ? new Date(postedRaw).toISOString() : new Date().toISOString();
  const text = `${title}\n${body}`;
  return {
    id: String(id),
    platform,
    authorHandle: handle,
    postedAt,
    caption: text.trim(),
    hashtags: [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0]),
    url: entryLink(e),
    mediaUrls: img ? [img] : [],
    videoUrl: video,
    source,
  };
}

export async function fetchViaRsshub(
  platform: Platform,
  handle: string,
  source: string,
  limit = 20,
): Promise<FeedItem[]> {
  if (!settings.rsshubUrl) throw new Error("RSSHUB_URL not configured");
  const url = `${settings.rsshubUrl}${rsshubRoute(platform, handle)}?limit=${limit}`;
  const res = await fetch(url, {
    headers: { "user-agent": "feedflag/0.1 (+https://github.com/duncombe/feedflag)" },
  });
  if (!res.ok) throw new Error(`RSSHub ${res.status} ${url}`);
  const doc: any = xmlParser.parse(await res.text());
  const entries = toArray(doc?.rss?.channel?.item).length
    ? toArray(doc.rss.channel.item)
    : toArray(doc?.feed?.entry);
  return entries
    .map((e) => toFeedItem(e, platform, handle, source))
    .filter((x): x is FeedItem => x !== null);
}