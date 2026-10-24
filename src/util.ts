/** Map with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  xs: readonly T[],
  limit: number,
  f: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(xs.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, xs.length));
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= xs.length) return;
      results[i] = await f(xs[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

import { createHash } from "node:crypto";

/** Stable short id for an observation — the feedback-loop reference key
 *  used in Slack digests and scripts/label.ts. */
export function observationId(o: {
  source_ref?: string;
  observed_at: string;
  domain: string;
}): string {
  return createHash("sha256")
    .update(`${o.domain}:${o.source_ref}:${o.observed_at}`)
    .digest("hex")
    .slice(0, 8);
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

export function excerpt(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}
