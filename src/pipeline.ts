import { loadFeedsConfig, settings } from "./config.js";
import { fetchViaRsshub } from "./ingest/rsshub.js";
import { normalizeApifyRecord, runApifyActor } from "./ingest/apify.js";
import { describeItem } from "./describe/openrouter.js";
import { resolveClassifier } from "./classify/index.js";
import { resolveNotifier } from "./notify/index.js";
import { appendFlagged, appendObservations, readSyncStamp, writeSyncStamp, SeenStore } from "./store/jsonl.js";
import { toObservation } from "./emit/records.js";
import { fetchSiteReportsSince, reportsToObservations } from "./ingest/reports.js";
import { dedupeById, mapLimit } from "./util.js";
import type { FeedItem, FlaggedItem, Observation } from "./types.js";

export interface RunOptions {
  dryRun?: boolean;
  limit?: number;
  skipNotify?: boolean;
  /** Substring match against "platform/handle" or source label */
  sourceFilter?: string;
}

export async function runPipeline(opts: RunOptions = {}) {
  const cfg = loadFeedsConfig();
  const categories = cfg.categories;

  // 1) Ingest — each source independent; one failure shouldn't sink the run.
  const settled = await Promise.allSettled(
    cfg.sources.map(async (s) => {
      if (s.adapter === "rsshub") {
        if (!s.handle) throw new Error(`rsshub source needs a handle: ${JSON.stringify(s)}`);
        return fetchViaRsshub(s.platform, s.handle, `rsshub:${s.platform}/${s.handle}`, s.limit ?? 20);
      }
      if (s.adapter === "apify") {
        if (!s.actor) throw new Error(`apify source needs an actor: ${JSON.stringify(s)}`);
        const raw = await runApifyActor(s.actor, s.input ?? {});
        return raw
          .map((r, i) => normalizeApifyRecord(r, s.platform, `apify:${s.actor}#${i}`))
          .filter((x): x is FeedItem => x !== null);
      }
      throw new Error(`unknown adapter "${s.adapter}"`);
    }),
  );
  const fetched: FeedItem[] = [];
  settled.forEach((r, i) => {
    const s = cfg.sources[i]!;
    const label = `${s.platform}/${s.handle ?? s.actor ?? "?"}`;
    if (r.status === "fulfilled") {
      console.log(`[feedflag] ${label}: ${r.value.length} items`);
      fetched.push(...r.value);
    } else {
      console.warn(`[feedflag] ${label} FAILED: ${String(r.reason).slice(0, 200)}`);
    }
  });

  // 2) Dedupe, filter seen, newest-first, cap the run.
  const seen = new SeenStore();
  await seen.load();
  let queue = dedupeById(fetched)
    .filter((it) => !seen.has(it.id))
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  if (opts.sourceFilter) {
    queue = queue.filter(
      (it) => `${it.platform}/${it.authorHandle}`.includes(opts.sourceFilter!) || it.source.includes(opts.sourceFilter!),
    );
  }
  queue = queue.slice(0, opts.limit ?? settings.maxPostsPerRun);
  console.log(`[feedflag] ${queue.length} new posts to process (${fetched.length} fetched)`);

  // 3) Describe (OpenRouter vision) + classify (Jev / fallback).
  const classifier = resolveClassifier();
  const notifier = opts.skipNotify || opts.dryRun ? null : resolveNotifier();
  const flagged: FlaggedItem[] = [];
  const processed = await mapLimit(queue, settings.describeConcurrency, async (item) => {
    const description = await describeItem(item).catch((err) => {
      console.warn(`[feedflag] describe failed ${item.id}: ${String(err).slice(0, 150)}`);
      return null;
    });
    if (!description) return null;
    const classification = await classifier.classify(description, categories).catch((err) => {
      console.warn(`[feedflag] classify failed ${item.id}: ${String(err).slice(0, 150)}`);
      return null;
    });
    if (!classification) return null;
    const f: FlaggedItem = { item, description, classification };
    const isFlag =
      classification.relevant &&
      classification.confidence >= settings.flagConfidence &&
      (cfg.flagCategories ?? categories).includes(classification.category);
    if (isFlag) flagged.push(f);
    return f;
  });
  const done = processed.filter((x): x is FlaggedItem => x !== null);

  // 4) Deliver + persist state + emit aggregator-ready observations.
  for (const f of flagged) {
    if (!opts.dryRun) await appendFlagged(f);
    const line = `🚩 ${f.item.platform}/@${f.item.authorHandle} -> ${f.classification.category} ` +
      `(${(f.classification.confidence * 100).toFixed(0)}% via ${f.classification.provider})`;
    if (notifier) {
      await notifier.notify(f).catch((err) => console.warn(`[feedflag] notify failed: ${String(err).slice(0, 150)}`));
    }
    console.log(line);
  }
  // 5) Crowd leg: site reports as ground-truth observations (incremental).
  let crowd: Observation[] = [];
  if (settings.pizzabaseUrl) {
    const since = await readSyncStamp();
    const reports = await fetchSiteReportsSince(
      since,
      opts.limit ?? settings.siteReportsMax,
    ).catch((err) => {
      console.warn(`[feedflag] crowd leg failed: ${String(err).slice(0, 150)}`);
      return [];
    });
    if (reports.length) {
      crowd = await reportsToObservations(reports, settings.describeConcurrency);
      console.log(`[feedflag] crowd leg: ${reports.length} site reports -> observations`);
    }
  }

  // 6) Persist observations + state.
  if (!opts.dryRun) {
    await appendObservations([...done.map(toObservation), ...crowd]);
    await writeSyncStamp();
    await seen.addAll(done.map((f) => ({ id: f.item.id, postedAt: f.item.postedAt })));
  }
  console.log(
    `[feedflag] run complete: ${done.length} processed, ${flagged.length} flagged` +
      (opts.dryRun ? " (dry run — nothing delivered)" : ""),
  );
  return { processed: done.length, flagged: flagged.length };
}