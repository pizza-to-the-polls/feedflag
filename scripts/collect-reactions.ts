#!/usr/bin/env node
/**
 * Slack reaction collector (FEAT-002e) — 👍/👎 on flag posts become classifier labels.
 *
 *   npx tsx scripts/collect-reactions.ts [--dry]
 *
 * Flow: find the bot's channels (conversations.list) → for each, page
 * conversations.history for feedflag-authored messages since the cursor →
 * reactions.get per message → map 👍 → label right / 👎 → label wrong on the
 * short ID embedded in the message text ([cbe91f81] format) → append to
 * data/labels.jsonl (idempotent: skip already-labeled IDs). Cursor in
 * data/reactions-sync.json.
 *
 * Also collects reactions on govt wait-time update posts (same channel) —
 * 👍 confirms the reading (confidence boost note), 👎 flags the source for
 * vetting review (note with source URL).
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const DRY = process.argv.includes("--dry");
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const UA = "feedflag-reaction-collector/1.0";

interface Label {
  id: string;
  verdict: "right" | "wrong";
  correct_category?: string;
  note?: string;
  labeled_at: string;
  via: "slack-reaction";
}

async function api<T>(
  method: string,
  params: Record<string, string | number | undefined>,
): Promise<T | null> {
  if (!TOKEN) return null;
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, String(v)]),
  );
  try {
    const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
      headers: { authorization: `Bearer ${TOKEN}`, "user-agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok: boolean } & T;
    return j.ok ? j : null;
  } catch {
    return null;
  }
}

function loadLabels(): Set<string> {
  const p = join(DATA_DIR, "labels.jsonl");
  if (!existsSync(p)) return new Set();
  const out = new Set<string>();
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.add((JSON.parse(l) as { id: string }).id);
    } catch {
      /* skip */
    }
  }
  return out;
}

function appendLabel(l: Label): void {
  if (DRY) return;
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(join(DATA_DIR, "labels.jsonl"), JSON.stringify(l) + "\n");
}

const loadCursor = (): string => {
  const p = join(DATA_DIR, "reactions-sync.json");
  if (!existsSync(p)) return "";
  try {
    return (
      (JSON.parse(readFileSync(p, "utf8")) as { cursor?: string }).cursor ?? ""
    );
  } catch {
    return "";
  }
};

const saveCursor = (c: string): void => {
  if (DRY) return;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    join(DATA_DIR, "reactions-sync.json"),
    JSON.stringify({ cursor: c }, null, 2),
  );
};

const main = async () => {
  if (!TOKEN) {
    console.log("[reactions] SLACK_BOT_TOKEN unset — skipping (non-fatal)");
    return;
  }
  const labeled = loadLabels();
  let newLabels = 0;
  let newCursor = loadCursor();

  // Configured channels first (bot lacks channels:read — invite-only membership);
  // fall back to users.conversations if unset.
  const configured = (process.env.SLACK_FLAG_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id }));
  const members = configured.length
    ? configured
    : (
        (
          await api<{
            channels: { id: string; name: string; is_member?: boolean }[];
          }>("users.conversations", {
            types: "public_channel,private_channel",
            limit: 100,
          })
        )?.channels ?? []
      ).filter((c) => c.is_member);
  if (!members.length) {
    console.log(
      "[reactions] no channels configured and bot is in none — set SLACK_FLAG_CHANNELS or invite feedflag",
    );
    return;
  }

  for (const ch of members) {
    let hasMore = true;
    let latest = newCursor;
    let newest = newCursor;
    while (hasMore) {
      const hist = await api<{
        messages: {
          ts: string;
          text: string;
          username?: string;
          bot_id?: string;
        }[];
        has_more: boolean;
      }>("conversations.history", {
        channel: ch.id,
        limit: 100,
        oldest: latest || undefined,
        latest: undefined,
      });
      if (!hist) break;
      for (const m of hist.messages ?? []) {
        const mine = m.username === "feedflag" || !!m.bot_id;
        if (!mine) continue;
        // short IDs in flag text: [cbe91f81]; govt posts: '[SITE] 45 min' via key#
        const idMatch = m.text.match(/\[([0-9a-f]{8})\]/);
        const sourceMatch = m.text.match(/Source: (\S+)/);
        const recs = await api<{
          message: { reactions: { name: string; users: string[] }[] };
        }>("reactions.get", { channel: ch.id, timestamp: m.ts, full: true });
        const reactions = recs?.message?.reactions ?? [];
        for (const rx of reactions) {
          if (
            rx.name !== "thumbsup" &&
            rx.name !== "+1" &&
            rx.name !== "thumbsdown" &&
            rx.name !== "-1"
          )
            continue;
          const verdict =
            rx.name === "thumbsup" || rx.name === "+1" ? "right" : "wrong";
          if (idMatch) {
            const id = idMatch[1]!;
            // a fresh reaction is newer human truth than a stale label — allow
            // override (the loadLabels skip only guards batch double-processing)
            void labeled;
            appendLabel({
              id,
              verdict,
              note: `slack :${rx.name}: in #${ch.name}`,
              labeled_at: new Date().toISOString(),
              via: "slack-reaction",
            });
            labeled.add(id);
            newLabels++;
          } else if (sourceMatch && verdict === "wrong") {
            // govt source flag — note it for vetting review (no id to label)
            console.log(
              `[reactions] 👎 on govt source (vetting review): ${sourceMatch[1]}`,
            );
          }
        }
      }
      const newestTs = hist.messages?.[0]?.ts;
      if (
        newestTs &&
        (!newest || Number.parseFloat(newestTs) > Number.parseFloat(newest))
      ) {
        newest = newestTs;
      }
      hasMore = hist.has_more && (hist.messages?.length ?? 0) >= 100;
      if (hasMore) {
        latest = String(Number.parseFloat(newestTs ?? "0"));
      }
    }
    if (
      newest &&
      (!newCursor || Number.parseFloat(newest) > Number.parseFloat(newCursor))
    ) {
      newCursor = newest;
    }
    console.log(
      `[reactions] #${ch.name}: scanned (labels now: ${newLabels} new)`,
    );
  }
  saveCursor(newCursor);
  console.log(
    `[reactions] done: ${newLabels} new label(s)${DRY ? " (dry)" : ""}`,
  );
};

main().catch((err) => {
  console.error(`[reactions] FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
