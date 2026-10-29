/**
 * Triple Helix pillar-3 gate (issue #39): enforces the intents/ contracts.
 *
 * Everything feedflag guarantees used to live in prose (TECHNICAL_DESIGN.md
 * decisions D1–D7, README architecture, per-file docblocks). intents/*.yml
 * makes those guarantees machine-readable and versioned; this gate is the
 * "enforced through tooling" half of the Triple Helix organizational
 * contract. It exits non-zero when:
 *
 *   1. a src/<dir>/ has no intent file, or an intent maps to no real code
 *      (no orphans either way; `pipeline` and `extract-wait-times` map to
 *      their single files);
 *   2. an intent is malformed — bad YAML, missing keys, layer/status outside
 *      the five/three allowed values, or an id not matching
 *      feedflag.intent/<module>@<n>;
 *   3. an invariant is empty or exceeds 200 characters;
 *   4. the feedflag/observation@N literal disagrees between the source files
 *      that carry it, or an intent names a schema version the source does
 *      not carry (the version is read from source here — never restated);
 *   5. Σ cost_per_week_usd_max across all intents exceeds the README's
 *      $350/wk ceiling.
 *
 * YAML parsing is a tiny hand-rolled parser scoped to the intent schema
 * (flat keys, one level of nesting, lists of strings) — no new dependency.
 *
 * Run: npx tsx scripts/test-intents.ts (auto-discovered once the test
 * glob runner from issue #38 lands).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const INTENTS_DIR = join(ROOT, "intents");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const LAYERS = [
  "reliable-data",
  "intelligence",
  "insight",
  "recommendation",
  "decision",
];
const STATUSES = ["planned", "implemented", "degraded"];
const REQUIRED_KEYS = [
  "id",
  "module",
  "layer",
  "decision",
  "consumer",
  "contract",
  "tests",
  "status",
];
const REQUIRED_CONTRACT_KEYS = [
  "input",
  "output",
  "invariants",
  "fallback",
  "sla",
  "pii",
];
const REQUIRED_SLA_KEYS = [
  "latency_ms_p95",
  "freshness",
  "cost_per_week_usd_max",
];
const ID_PATTERN = /^feedflag\.intent\/([a-z][a-z0-9-]*)@(\d+)$/;
const INVARIANT_MAX_LENGTH = 200;
/** README "Cost options": the ask is < $350/wk — the gate cross-checks the
 *  doc so this constant cannot silently drift from it. */
const COST_CEILING_USD_PER_WEEK = 350;
/** Intents that bind a single file rather than a src/<dir>/. */
const SPECIAL_INTENTS: Record<string, string> = {
  pipeline: "src/pipeline.ts",
  "extract-wait-times": "scripts/extract-wait-times.ts",
};

interface Intent {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser — scoped to the intent schema (flat keys, one level of
// nesting, lists of strings, quoted or bare scalars, full-line comments).
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    parseIntentYaml(
      [
        "# leading comment",
        "id: feedflag.intent/demo@1",
        "module: src/demo/  # trailing comment on a bare value",
        'layer: "intelligence"',
        "count: 42",
        "contract:",
        "  input: text only",
        "  sla:",
        "    latency_ms_p95: 1000",
        "  invariants:",
        '    - "no string generation — typed values only"',
        "    - plain fallback line",
        "  nested:",
        "    deep: true-ish",
        "status: implemented",
      ].join("\n"),
    ),
    {
      id: "feedflag.intent/demo@1",
      module: "src/demo/",
      layer: "intelligence",
      count: 42,
      contract: {
        input: "text only",
        sla: { latency_ms_p95: 1000 },
        invariants: [
          "no string generation — typed values only",
          "plain fallback line",
        ],
        nested: { deep: "true-ish" },
      },
      status: "implemented",
    },
    "parser: scalars, nesting, lists, comments",
  );

  assert.deepEqual(
    parseIntentYaml("contract:\nstatus: implemented\n"),
    { contract: {}, status: "implemented" },
    "parser: a section with no children becomes an empty object",
  );

  assert.deepEqual(
    parseIntentYaml("a: 1\n\tb: 2"),
    { a: 1, b: 2 },
    "parser: tabs are coerced to two spaces, never fatal",
  );
  assert.throws(
    () => parseIntentYaml("- orphan list item"),
    "parser: a list item without a parent key throws",
  );
  assert.throws(
    () => parseIntentYaml('broken: "unterminated'),
    "parser: an unterminated quoted string throws",
  );
  assert.throws(
    () => parseIntentYaml("not a yaml line"),
    "parser: a line without key: value throws",
  );

  console.log("  ✓ YAML parser: scalars, nesting, lists, comments, errors");
}

function parseIntentYaml(text: string): Intent {
  const root: Intent = {};
  const stack: { indent: number; obj: Intent }[] = [{ indent: -1, obj: root }];
  let pending: { parent: Intent; key: string; indent: number } | null = null;
  let list: { arr: string[]; indent: number } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed.startsWith("- ")) {
      if (pending) {
        const arr: string[] = [];
        pending.parent[pending.key] = arr;
        list = { arr, indent: pending.indent };
        pending = null;
      }
      if (!list || indent <= list.indent) {
        throw new Error(`list item without a parent key: ${trimmed}`);
      }
      list.arr.push(String(parseScalar(trimmed.slice(2))));
      continue;
    }
    const m = trimmed.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) throw new Error(`unparseable line: ${trimmed}`);
    const key = m[1]!;
    const rest = m[2] ?? "";
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    list = null;
    if (rest === "") {
      pending = { parent: stack[stack.length - 1]!.obj, key, indent };
      continue;
    }
    if (pending) {
      if (indent > pending.indent) {
        const child: Intent = {};
        pending.parent[pending.key] = child;
        stack.push({ indent: pending.indent, obj: child });
      } else {
        pending.parent[pending.key] = {};
      }
      pending = null;
    }
    stack[stack.length - 1]!.obj[key] = parseScalar(rest);
  }
  if (pending) pending.parent[pending.key] = {};
  return root;
}

function parseScalar(raw: string): string | number {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) throw new Error(`unterminated string: ${raw}`);
    return s.slice(1, end);
  }
  const bare = s.split(/\s+#/)[0]!.trim();
  if (/^-?\d+$/.test(bare)) return Number(bare);
  return bare;
}

function requireString(intent: Intent, key: string, file: string): string {
  const v = intent[key];
  assert.equal(typeof v, "string", `${file}: ${key} must be a string`);
  assert.ok(
    (v as string).trim().length > 0,
    `${file}: ${key} must be non-empty`,
  );
  return v as string;
}

// ---------------------------------------------------------------------------
// Rule 1 — bidirectional module ↔ intent mapping (no orphans either way)
// ---------------------------------------------------------------------------
const srcDirs = readdirSync(join(ROOT, "src"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const intentFiles = readdirSync(INTENTS_DIR)
  .filter((f) => f.endsWith(".yml"))
  .sort();

const intents = new Map<string, Intent>();
const intentCosts = new Map<string, number>();

for (const file of intentFiles) {
  const name = file.replace(/\.yml$/, "");
  const intent = parseIntentYaml(
    readFileSync(join(INTENTS_DIR, file), "utf8"),
  );
  intents.set(name, intent);

  // Rule 2 — schema: required keys, types, layer/status, id shape
  const fileRef = `intents/${file}`;
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in intent, `${fileRef}: missing required key "${key}"`);
  }
  for (const key of [
    "decision",
    "consumer",
    "module",
    "tests",
    "status",
    "layer",
  ]) {
    requireString(intent, key, fileRef);
  }
  const id = requireString(intent, "id", fileRef);
  const idMatch = ID_PATTERN.exec(id);
  assert.ok(
    idMatch,
    `${fileRef}: id must match feedflag.intent/<module>@<n>, got "${id}"`,
  );
  assert.equal(
    idMatch[1],
    name,
    `${fileRef}: id module "${idMatch[1]}" must match the filename`,
  );
  assert.ok(
    LAYERS.includes(intent.layer as string),
    `${fileRef}: layer "${intent.layer}" must be one of ${LAYERS.join(" | ")}`,
  );
  assert.ok(
    STATUSES.includes(intent.status as string),
    `${fileRef}: status "${intent.status}" must be one of ${STATUSES.join(" | ")}`,
  );

  const contract = intent.contract;
  assert.equal(
    typeof contract,
    "object",
    `${fileRef}: contract must be a mapping`,
  );
  assert.ok(contract !== null, `${fileRef}: contract must not be null`);
  const c = contract as Intent;
  for (const key of REQUIRED_CONTRACT_KEYS) {
    assert.ok(key in c, `${fileRef}: contract missing "${key}"`);
  }
  for (const key of ["input", "output", "fallback", "pii"]) {
    requireString(c, key, fileRef);
  }

  // Rule 3 — invariants: non-empty, bounded
  assert.ok(
    Array.isArray(c.invariants),
    `${fileRef}: contract.invariants must be a list`,
  );
  const invariants = c.invariants as unknown[];
  assert.ok(
    invariants.length > 0,
    `${fileRef}: contract.invariants must not be empty`,
  );
  for (const inv of invariants) {
    assert.equal(
      typeof inv,
      "string",
      `${fileRef}: every invariant must be a string`,
    );
    const s = inv as string;
    assert.ok(s.trim().length > 0, `${fileRef}: empty invariant "${s}"`);
    assert.ok(
      s.length <= INVARIANT_MAX_LENGTH,
      `${fileRef}: invariant exceeds ${INVARIANT_MAX_LENGTH} chars (${s.length}): "${s.slice(0, 60)}…"`,
    );
  }

  const sla = c.sla;
  assert.equal(
    typeof sla,
    "object",
    `${fileRef}: contract.sla must be a mapping`,
  );
  assert.ok(sla !== null, `${fileRef}: contract.sla must not be null`);
  const s = sla as Intent;
  for (const key of REQUIRED_SLA_KEYS) {
    assert.ok(key in s, `${fileRef}: contract.sla missing "${key}"`);
  }
  assert.equal(
    typeof s.latency_ms_p95,
    "number",
    `${fileRef}: sla.latency_ms_p95 must be a number`,
  );
  assert.ok(
    (s.latency_ms_p95 as number) > 0,
    `${fileRef}: sla.latency_ms_p95 must be positive`,
  );
  requireString(s, "freshness", fileRef);
  assert.equal(
    typeof s.cost_per_week_usd_max,
    "number",
    `${fileRef}: sla.cost_per_week_usd_max must be a number`,
  );
  assert.ok(
    (s.cost_per_week_usd_max as number) >= 0,
    `${fileRef}: sla.cost_per_week_usd_max must be >= 0`,
  );
  intentCosts.set(name, s.cost_per_week_usd_max as number);

  // Rule 1 (intent → code): the module must exist and match the file name.
  const expected = SPECIAL_INTENTS[name] ?? `src/${name}/`;
  assert.equal(
    intent.module,
    expected,
    `${fileRef}: module must be "${expected}"`,
  );
  assert.ok(
    existsSync(join(ROOT, expected)),
    `${fileRef}: module "${expected}" does not exist on disk (orphan intent)`,
  );
}

// Rule 1 (code → intent): every src/<dir>/ has a corresponding intent file.
for (const dir of srcDirs) {
  assert.ok(
    intentFiles.includes(`${dir}.yml`),
    `src/${dir}/ has no intent file — expected intents/${dir}.yml`,
  );
}

console.log(
  `  ✓ rule 1: ${srcDirs.length} src dirs ↔ ${intentFiles.length} intent files, ` +
    `no orphans either way`,
);
console.log(
  `  ✓ rule 2: every intent parses with all required keys, valid ` +
    `layer/status, and a feedflag.intent/<module>@<n> id`,
);
console.log(
  `  ✓ rule 3: every invariant non-empty and <= ${INVARIANT_MAX_LENGTH} characters`,
);

// ---------------------------------------------------------------------------
// Rule 4 — observation schema version sync: the version is read from the
// source files that carry the literal, never restated here.
// ---------------------------------------------------------------------------
const SCHEMA_FILES = [
  "src/types.ts",
  "src/emit/records.ts",
  "src/ingest/reports.ts",
  "scripts/extract-wait-times.ts",
];
const SCHEMA_SOURCE = "feedflag/observation@(\\d+)";
const schemaMatches = (text: string): RegExpMatchArray[] =>
  [...text.matchAll(new RegExp(SCHEMA_SOURCE, "g"))];

const versions = new Map<number, string[]>();
for (const file of SCHEMA_FILES) {
  const src = read(file);
  const matches = schemaMatches(src);
  assert.ok(
    matches.length > 0,
    `${file}: expected at least one feedflag/observation@N literal`,
  );
  for (const m of matches) {
    const v = Number(m[1]);
    const files = versions.get(v) ?? [];
    files.push(file);
    versions.set(v, files);
  }
}
const versionReport = [...versions.entries()]
  .map(([v, files]) => `@${v} in ${files.join(", ")}`)
  .join("; ");
assert.equal(
  versions.size,
  1,
  `observation schema version disagrees: ${versionReport}`,
);
const schemaVersion = [...versions.keys()][0]!;

let schemaMentioningIntents = 0;
for (const [name, intent] of intents) {
  const declared = schemaMatches(JSON.stringify(intent));
  if (declared.length === 0) continue;
  schemaMentioningIntents++;
  for (const d of declared) {
    assert.equal(
      Number(d[1]),
      schemaVersion,
      `intents/${name}.yml declares feedflag/observation@${d[1]} but the ` +
        `source files carry @${schemaVersion} — bump the intent`,
    );
  }
}
assert.ok(
  schemaMentioningIntents > 0,
  "no intent names the observation schema — emit/pipeline must declare it",
);

console.log(
  `  ✓ rule 4: feedflag/observation@${schemaVersion} agrees across ` +
    `${SCHEMA_FILES.length} source files and ${schemaMentioningIntents} intent(s)`,
);

// ---------------------------------------------------------------------------
// Rule 5 — cost ceiling: Σ cost_per_week_usd_max <= README's $350/wk ask
// ---------------------------------------------------------------------------
assert.ok(
  read("README.md").includes("$350/wk"),
  "README.md no longer states the $350/wk ceiling — update COST_CEILING_USD_PER_WEEK",
);
let totalCost = 0;
for (const [name, cost] of intentCosts) {
  totalCost += cost;
  console.log(
    `      ${name.padEnd(20)} $${cost}/wk` +
      (cost === 0 ? "  (pure/no-API)" : ""),
  );
}
assert.ok(
  totalCost <= COST_CEILING_USD_PER_WEEK,
  `Σ cost_per_week_usd_max = $${totalCost}/wk exceeds the $${COST_CEILING_USD_PER_WEEK}/wk ceiling`,
);
console.log(
  `  ✓ rule 5: Σ cost_per_week_usd_max = $${totalCost}/wk <= ` +
    `$${COST_CEILING_USD_PER_WEEK}/wk ceiling`,
);

let invariantCount = 0;
for (const intent of intents.values()) {
  const inv = (intent.contract as Intent).invariants;
  invariantCount += Array.isArray(inv) ? inv.length : 0;
}
console.log(
  `\nAll intent contracts hold (${intents.size} intents, ` +
    `${invariantCount} invariants).`,
);
