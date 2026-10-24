import type { DescriptionSet } from "../types.js";
import { excerpt } from "../util.js";

/** Flatten a description set into the string fields JEV scores against. */
export function renderInput(d: DescriptionSet): Record<string, string> {
  return {
    platform: d.item.platform,
    author: d.item.authorHandle,
    posted_at: d.item.postedAt,
    caption: excerpt(d.caption, 4000),
    image_descriptions: d.imageDescriptions
      .map((s, i) => `[image ${i + 1}] ${s}`)
      .join("\n")
      .slice(0, 4000),
    video_summary: d.videoSummary ?? "",
    hashtags: d.item.hashtags.join(" "),
    url: d.item.url ?? "",
  };
}
