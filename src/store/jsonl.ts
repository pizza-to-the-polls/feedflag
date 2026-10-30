import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { settings } from "../config.js";
import type { FlaggedItem, Observation } from "../types.js";

/** Tiny JSON file set of processed post ids — keeps us from re-paying for captioning. */
export class SeenStore {
  private dataDir: string;
  private path: string;
  private seen = new Map<string, string>();

  /** `dataDir` is injectable so tests can run against a mkdtemp dir without
   *  mutating `process.env` or touching the real `./data` (issue #56). */
  constructor(dataDir: string = settings.dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "seen.json");
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<
        string,
        string
      >;
      this.seen = new Map(Object.entries(raw));
    } catch {
      this.seen = new Map();
    }
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  async addAll(entries: { id: string; postedAt: string }[]): Promise<void> {
    for (const e of entries) this.seen.set(e.id, e.postedAt);
    const obj: Record<string, string> = Object.fromEntries(this.seen);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.path, JSON.stringify(obj, null, 2));
  }
}

export async function appendFlagged(
  flag: FlaggedItem,
  dataDir: string = settings.dataDir,
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id: flag.item.id,
    platform: flag.item.platform,
    author: flag.item.authorHandle,
    url: flag.item.url,
    category: flag.classification.category,
    confidence: flag.classification.confidence,
    provider: flag.classification.provider,
  });
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, "flagged.jsonl"), line + "\n");
}

/** Append normalized, aggregator-ready records (see docs in README "Future scope"). */
export async function appendObservations(
  observations: Observation[],
  dataDir: string = settings.dataDir,
): Promise<void> {
  if (observations.length === 0) return;
  await mkdir(dataDir, { recursive: true });
  const lines = observations.map((o) => JSON.stringify(o)).join("\n") + "\n";
  await appendFile(join(dataDir, "observations.jsonl"), lines);
}

/** Incremental crowd-leg cursor: last time we synced site reports. */
export async function readSyncStamp(
  dataDir: string = settings.dataDir,
): Promise<string> {
  const path = join(dataDir, "reports-sync.json");
  if (!existsSync(path)) return new Date(0).toISOString();
  try {
    return JSON.parse(await readFile(path, "utf8")).since as string;
  } catch {
    return new Date(0).toISOString();
  }
}

export async function writeSyncStamp(
  dataDir: string = settings.dataDir,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "reports-sync.json");
  await writeFile(
    path,
    JSON.stringify({ since: new Date().toISOString() }, null, 2),
  );
}
