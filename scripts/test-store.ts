/**
 * Regression tests for the store leg (src/store/jsonl.ts) — issue #56,
 * triple helix pillar 1b (I/O seams).
 *
 * Before #56 every store function read `settings.dataDir` inline, so the
 * only way to exercise the persistence code paths was to write to the real
 * `./data` directory (or mutate `process.env.DATA_DIR`, which is a process
 * global no suite should touch). The seam now takes the target directory as
 * a trailing argument, defaulting to `settings.dataDir` — so every function
 * here runs against a `mkdtemp` directory: real filesystem code paths (the
 * strongest proof this seam can give), no env mutation, no writes to
 * `./data`.
 *
 * Pinned contracts (intents/store.yml):
 *   - seen.json prevents re-paying for captioning (load/has/addAll round trip)
 *   - the bus is append-only JSONL (flagged.jsonl / observations.jsonl)
 *   - a corrupt or unreadable seen.json / sync stamp resets to empty rather
 *     than failing the run (the fail-open contract)
 *   - appendObservations writes nothing for an empty batch
 *
 * Run: npm test (discovered via the scripts/test-*.ts glob, issue #38)
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../src/config.js";
import {
  SeenStore,
  appendFlagged,
  appendObservations,
  readSyncStamp,
  writeSyncStamp,
} from "../src/store/jsonl.js";
import type { FlaggedItem, Observation } from "../src/types.js";

console.log("store leg regression tests (issue #56)\n");

const EPOCH = new Date(0).toISOString();

/** Synthetic fixtures — invented ids/handles, example.invalid URLs only. */
function flaggedFixture(): FlaggedItem {
  return {
    item: {
      id: "synthetic-post-1",
      platform: "instagram",
      authorHandle: "@synthetic-account",
      postedAt: "2026-11-02T15:04:05.000Z",
      caption: "synthetic caption for the fixture post",
      hashtags: ["#synthetic"],
      mediaUrls: [],
      url: "https://example.invalid/p/1",
      source: "rsshub:instagram:synthetic-account",
    },
    description: {
      item: {
        id: "synthetic-post-1",
        platform: "instagram",
        authorHandle: "@synthetic-account",
        postedAt: "2026-11-02T15:04:05.000Z",
        caption: "synthetic caption for the fixture post",
        hashtags: ["#synthetic"],
        mediaUrls: [],
        url: "https://example.invalid/p/1",
        source: "rsshub:instagram:synthetic-account",
      },
      caption: "synthetic caption for the fixture post",
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

function observationFixture(n: number): Observation {
  const postedAt = `2026-11-02T15:04:0${n}.000Z`;
  return {
    schema: "feedflag/observation@1",
    domain: "social",
    source_ref: "rsshub:instagram:synthetic-account",
    url: `https://example.invalid/p/${n}`,
    author: "@synthetic-account",
    platform: "instagram",
    observed_at: postedAt,
    posted_at: postedAt,
    signal_kind: "poll_line_report",
    confidence: 0.9,
    provider: "typesafe/jev-router",
    relevant: true,
    description: {
      item: {
        id: `synthetic-post-${n}`,
        platform: "instagram",
        authorHandle: "@synthetic-account",
        postedAt,
        caption: `synthetic caption ${n}`,
        hashtags: [],
        mediaUrls: [],
        url: `https://example.invalid/p/${n}`,
        source: "rsshub:instagram:synthetic-account",
      },
      caption: `synthetic caption ${n}`,
      imageDescriptions: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Guard: the whole suite runs without touching the real ./data or the env
// ---------------------------------------------------------------------------
{
  const envDataDirBefore = process.env.DATA_DIR;
  const realDir = settings.dataDir;
  const realDirExisted = existsSync(realDir);
  const realFilesBefore = realDirExisted ? readdirSync(realDir).sort() : null;

  // Persist the guard state for the end-of-suite check (closure over the
  // process-lifetime values, not the fixture dir).
  (globalThis as Record<string, unknown>).__storeSuiteGuard = {
    envDataDirBefore,
    realDir,
    realDirExisted,
    realFilesBefore,
  };

  console.log("  ✓ guard armed: real ./data + DATA_DIR snapshot taken");
}

// ---------------------------------------------------------------------------
// SeenStore — load on an empty directory is an empty set (fail open)
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    const store = new SeenStore(dir);
    await store.load();
    assert.equal(store.has("synthetic-post-1"), false, "nothing seen yet");

    // The load path must not have created the directory contents beyond
    // mkdir — an empty dir stays empty (no seen.json is written by load).
    assert.deepEqual(
      readdirSync(dir).sort(),
      [],
      "load() on an empty dir writes nothing",
    );

    console.log("  ✓ SeenStore: load on an empty dir is an empty, quiet read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// SeenStore — addAll round trip through the real filesystem
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    const store = new SeenStore(dir);
    await store.load();
    await store.addAll([
      { id: "synthetic-post-1", postedAt: "2026-11-02T15:04:05.000Z" },
      { id: "synthetic-post-2", postedAt: "2026-11-02T15:04:06.000Z" },
    ]);
    assert.equal(store.has("synthetic-post-1"), true, "in-memory after addAll");

    // The file itself is the durable artifact — read it back raw and check
    // the JSON shape (id -> postedAt map, pretty-printed).
    const raw = JSON.parse(
      await readFile(join(dir, "seen.json"), "utf8"),
    ) as Record<string, string>;
    assert.deepEqual(raw, {
      "synthetic-post-1": "2026-11-02T15:04:05.000Z",
      "synthetic-post-2": "2026-11-02T15:04:06.000Z",
    });

    // A NEW store instance over the same dir must see the same state —
    // the dedupe contract spans runs via the file, not the process.
    const fresh = new SeenStore(dir);
    await fresh.load();
    assert.equal(fresh.has("synthetic-post-1"), true, "seen survives reload");
    assert.equal(
      fresh.has("synthetic-post-2"),
      true,
      "second entry survives reload",
    );
    assert.equal(
      fresh.has("synthetic-post-3"),
      false,
      "an absent id is still unseen",
    );

    console.log(
      "  ✓ SeenStore: addAll round-trips through seen.json; a new instance sees it",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// SeenStore — corrupt seen.json degrades to an empty set (fail open)
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    await writeFile(join(dir, "seen.json"), "{not valid json");
    const store = new SeenStore(dir);
    await store.load();
    assert.equal(
      store.has("synthetic-post-1"),
      false,
      "corrupt seen.json reads as empty — never fails the run",
    );

    // And the store stays usable: addAll after the corrupt read writes a
    // valid file (the recovery path).
    await store.addAll([{ id: "synthetic-post-9", postedAt: EPOCH }]);
    const raw = JSON.parse(
      await readFile(join(dir, "seen.json"), "utf8"),
    ) as Record<string, string>;
    assert.deepEqual(raw, { "synthetic-post-9": EPOCH });

    console.log(
      "  ✓ SeenStore: corrupt seen.json degrades to empty, then recovers",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// appendFlagged — the flagged.jsonl audit line
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    await appendFlagged(flaggedFixture(), dir);
    const lines = (await readFile(join(dir, "flagged.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 1, "one flag -> one JSONL line");
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(rec.id, "synthetic-post-1");
    assert.equal(rec.platform, "instagram");
    assert.equal(rec.author, "@synthetic-account");
    assert.equal(rec.url, "https://example.invalid/p/1");
    assert.equal(rec.category, "poll_line_report");
    assert.equal(rec.confidence, 0.9);
    assert.equal(rec.provider, "typesafe/jev-router");
    assert.match(
      String(rec.ts),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "ts is a UTC ISO timestamp",
    );

    // Appending twice must produce two lines (append-only audit log, D3).
    await appendFlagged(flaggedFixture(), dir);
    const lines2 = (await readFile(join(dir, "flagged.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(
      lines2.length,
      2,
      "second append is a new line, not a rewrite",
    );

    console.log(
      "  ✓ appendFlagged: one JSONL line per flag with the audit fields",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// appendObservations — the bus; empty batch writes nothing
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    await appendObservations([], dir);
    assert.equal(
      existsSync(join(dir, "observations.jsonl")),
      false,
      "empty batch writes nothing at all",
    );

    const obs = [observationFixture(1), observationFixture(2)];
    await appendObservations(obs, dir);
    const lines = (await readFile(join(dir, "observations.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines.length, 2, "two observations -> two JSONL lines");
    const parsed = lines.map((l) => JSON.parse(l) as Observation);
    assert.deepEqual(parsed, obs, "lines parse back to the exact input");

    // Appending again extends the bus (append-only, replayable).
    const obs3 = observationFixture(3);
    await appendObservations([obs3], dir);
    const lines3 = (await readFile(join(dir, "observations.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(lines3.length, 3, "the bus grows; earlier lines untouched");
    assert.deepEqual(JSON.parse(lines3[0]!), obs[0]);

    console.log(
      "  ✓ appendObservations: empty batch is a no-op; lines round-trip; bus grows",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sync stamp — read on a missing dir is the epoch; corrupt stamp fails open
// ---------------------------------------------------------------------------
{
  const dir = await mkdtemp(join(tmpdir(), "feedflag-store-"));
  try {
    assert.equal(
      await readSyncStamp(dir),
      EPOCH,
      "no stamp file -> epoch (first run)",
    );

    await writeSyncStamp(dir);
    const raw = JSON.parse(
      await readFile(join(dir, "reports-sync.json"), "utf8"),
    ) as { since: string };
    assert.match(
      raw.since,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "writeSyncStamp persists a UTC ISO cursor",
    );
    const readBack = await readSyncStamp(dir);
    assert.equal(readBack, raw.since, "read returns exactly what was written");
    assert.ok(
      Math.abs(Date.now() - Date.parse(readBack)) < 60_000,
      "the cursor is stamped now-ish",
    );

    // Corrupt stamp -> epoch (fail open, same contract as seen.json).
    await writeFile(join(dir, "reports-sync.json"), "{oops");
    assert.equal(
      await readSyncStamp(dir),
      EPOCH,
      "corrupt stamp resets to the epoch rather than failing the run",
    );

    console.log(
      "  ✓ sync stamp: epoch on missing, persists + reads back, corrupt fails open",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// End-of-suite guard: the real ./data and process.env are untouched
// ---------------------------------------------------------------------------
{
  const g = (globalThis as Record<string, unknown>).__storeSuiteGuard as {
    envDataDirBefore: string | undefined;
    realDir: string;
    realDirExisted: boolean;
    realFilesBefore: string[] | null;
  };
  assert.equal(
    process.env.DATA_DIR,
    g.envDataDirBefore,
    "process.env.DATA_DIR never mutated",
  );
  if (!g.realDirExisted) {
    assert.equal(
      existsSync(g.realDir),
      false,
      "the real ./data directory still does not exist — the suite never created it",
    );
  } else {
    assert.deepEqual(
      readdirSync(g.realDir).sort(),
      g.realFilesBefore,
      "the real ./data directory contents are unchanged",
    );
  }

  console.log(
    "  ✓ guard held: no writes to the real ./data, no process.env mutation",
  );
}

console.log("\nAll store regression tests passed.");
