#!/usr/bin/env node
import { runPipeline } from "./pipeline.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? "");
}

const opts = {
  dryRun: process.argv.includes("--dry-run"),
  skipNotify: process.argv.includes("--no-notify"),
  limit: Number(flag("limit")) || undefined,
  sourceFilter: flag("source"),
};

console.log(
  `[feedflag] start ${new Date().toISOString()}` +
    (opts.dryRun ? " [dry-run]" : "") +
    (opts.skipNotify ? " [no-notify]" : ""),
);

runPipeline(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[feedflag] FATAL: ${err?.stack ?? err}`);
    process.exit(1);
  });
