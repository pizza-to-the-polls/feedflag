/**
 * Triple Helix pillar-2e completeness gate (issue #44): the ratchet.
 *
 * The three pillars only hold if something FAILS THE BUILD when one goes
 * missing — and before this gate nothing did. PR #36 is the incident that
 * motivated it: nine new modules under src/locate/ (~1,453 lines) shipped
 * with zero tests while the test workflow stayed green, because suites were
 * hand-chained into package.json and an untested module was simply
 * invisible. Glob discovery (#38) fixed the forgotten-suite half; this gate
 * closes the cross-pillar half — the thing that makes the next untested
 * module impossible to merge:
 *
 *   1. every src/ module has an intent (pillar 3) AND a suite that actually
 *      imports it (pillar 2) — or a reviewed allowlist exception;
 *   2. every intents/*.yml `tests:` path exists AND is discovered by the
 *      runner's glob — the discovery floor that closes the #46 silent hole
 *      one level up: CI can never go green having run zero suites;
 *   3. no orphans in either direction: an intent's module must exist, a
 *      suite must not import a module that no longer exists, and an intent
 *      must not name a suite that does not exist;
 *   4. an intent may only claim `status: implemented` if some suite
 *      references its module (`planned`/`degraded` may go without one);
 *   5. the allowlist is honest: a module that gains a suite makes its entry
 *      stale, and a broken coverage chain makes its entry a lie — both fail
 *      the gate until the entry is removed or the chain restored.
 *
 * HOW: static text scanning, not instrumentation. Every scripts/test-*.ts is
 * read and scanned for `import … from "../src/…"` specifiers, normalised
 * ../src/foo/bar.js → src/foo/bar.ts. Type-only imports (`import type { … }`)
 * do NOT count as coverage — they name a module without executing any of it —
 * which is why purely type-only modules sit on the allowlist with a reason.
 * The module → suite mapping is many-to-one by design (normalize.yml and
 * emit.yml both point at test-pipeline-pure.ts; govt.yml and
 * extract-wait-times.yml both point at test-govwatch.ts) and the gate
 * accepts that; what it never accepts is a module with NO suite at all.
 *
 * Read-only by design: writes nothing, mutates no process.env, performs no
 * network I/O, needs no credentials, adds no dependency. Static scanning
 * runs in well under a second. Importing test-intents.js for the parser
 * (#39) also re-runs the intents gate in this process — read-only and
 * passing; that duplication is the price of not reimplementing the parser.
 *
 * Known gap NOT fixed here: tsconfig.json includes only src/, so
 * `tsc --noEmit` never type-checks scripts/ — widening it belongs in its
 * own issue.
 *
 * Run: npx tsx scripts/test-coverage-map.ts (auto-discovered by npm test).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { discoverSuites } from "./run-tests.js";
import { parseIntentYaml, type Intent } from "./test-intents.js";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");
const INTENTS_DIR = join(ROOT, "intents");

// ---------------------------------------------------------------------------
// Reviewed inventory constants — the explicit, versioned exceptions
// ---------------------------------------------------------------------------

/** The significant scripts/*.ts entrypoints (issue #44). Every .ts file in
 *  scripts/ must be a discovered suite, the runner, the harness, or listed
 *  here with a reason — an unclassified file fails the gate, so nothing
 *  enters the inventory unreviewed. */
const ENTRYPOINTS: Record<string, string> = {
  "scripts/collect-reactions.ts":
    "crowd-leg cron entrypoint — Slack reactions become classifier labels",
  "scripts/digest.ts":
    "operator CLI — prints the daily digest from the local observation bus",
  "scripts/emit-to-db.ts":
    "cron outbox — writes feed_observations to pizzabase, idempotently",
  "scripts/extract-wait-times.ts":
    "govwatch cron entrypoint — intent-bound single-file module",
  "scripts/label.ts":
    "operator CLI — human labels tune FLAG_CONFIDENCE and the fallback",
};

/** How an allowlisted module is covered without a direct suite import. */
type AllowlistKind = "entrypoint" | "type-only" | "transitive";

interface AllowlistEntry {
  kind: AllowlistKind;
  /** One-line reason this module has no direct suite (reviewed, honest). */
  reason: string;
}

/** Reviewed exceptions to direct suite coverage (issue #44). A stale entry
 *  (its module gained a suite) or a broken coverage chain fails the gate —
 *  an entry is removed or restored, never silently tolerated. A meaningless
 *  token test is worse than an honest allowlist entry. */
const ALLOWLIST: Record<string, AllowlistEntry> = {
  "src/index.ts": {
    kind: "entrypoint",
    reason:
      "27-line CLI shell — routes argv to runPipeline, which test-deliver.ts covers",
  },
  "src/types.ts": {
    kind: "type-only",
    reason:
      "type-only module: interfaces + type aliases, no runtime behaviour to test",
  },
  "src/locate/types.ts": {
    kind: "type-only",
    reason:
      "type-only DI surface for the resolve chain, exercised through test-locate.ts",
  },
  "src/locate/candidates.ts": {
    kind: "transitive",
    reason:
      "internal helper runtime-imported only by src/locate/resolve.ts (test-locate.ts)",
  },
  "src/locate/context.ts": {
    kind: "transitive",
    reason:
      "internal helper runtime-imported only by src/locate/resolve.ts (test-locate.ts)",
  },
  "src/locate/scope.ts": {
    kind: "transitive",
    reason:
      "internal helper runtime-imported only by src/locate/resolve.ts (test-locate.ts)",
  },
  "src/locate/similarity.ts": {
    kind: "transitive",
    reason:
      "internal helper runtime-imported only by src/locate/fuzzy.ts (test-locate.ts)",
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A suite's src/ imports, split by runtime relevance. */
interface SuiteImports {
  /** Specifiers imported at runtime — the module's code is executed. */
  runtime: string[];
  /** Specifiers imported as `import type` — named, never executed. */
  typeOnly: string[];
}

/** The intent fields this gate needs (parsed via #39's parseIntentYaml). */
interface IntentInfo {
  /** e.g. "intents/locate.yml" — for naming gaps in the output. */
  file: string;
  id: string;
  status: string;
  /** The declared tests: path, e.g. "scripts/test-locate.ts". */
  tests: string;
}

/** Everything the pure completeness checker needs, built from disk. */
interface CoverageInput {
  /** src/ directory modules, e.g. "src/locate/". */
  srcDirs: string[];
  /** Files per directory module, e.g. "src/locate/" → ["src/locate/fuzzy.ts"]. */
  dirFiles: Record<string, string[]>;
  /** Top-level src/*.ts files, e.g. "src/config.ts". */
  srcTopFiles: string[];
  /** Significant scripts/*.ts entrypoints, e.g. "scripts/digest.ts". */
  entrypoints: string[];
  /** module path → parsed intent (from intents/*.yml). */
  intents: Record<string, IntentInfo>;
  /** suite basename → the src files it imports (runtime vs type-only). */
  suiteImports: Record<string, SuiteImports>;
  /** src file → src files it runtime-imports (transitive verification). */
  srcRuntimeImports: Record<string, string[]>;
  /** Suite basenames the discovery glob actually finds. */
  discoveredSuites: string[];
  /** All scripts/*.ts paths on disk. */
  scriptFiles: string[];
  /** Declared tests: basenames whose file exists on disk. */
  declaredSuiteFiles: string[];
  allowlist: Record<string, AllowlistEntry>;
}

interface CoverageReport {
  /** Every gap found — empty when the ratchet holds. */
  gaps: string[];
  /** src file → suites that runtime-import it. */
  fileSuites: Record<string, string[]>;
  /** src dir → suites that runtime-import ≥1 of its files. */
  dirSuites: Record<string, string[]>;
  /** src file → suites that type-only-import it. */
  typeOnlySuites: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Static scanners — the "no instrumentation" half of the design
// ---------------------------------------------------------------------------

/** Matches a static import statement — named/default, single- or multi-line
 *  (import specifier lists never contain braces). Group 1 is `type ` for
 *  type-only imports; group 2 is the specifier. Dynamic import() is not
 *  matched — none exist in this repo. */
const IMPORT_RE =
  /import\s+(type\s+)?(?:\{[\s\S]*?\}|\w+)\s*from\s*["']([^"']+)["']/g;

interface RawImport {
  specifier: string;
  typeOnly: boolean;
}

/** Strip comments so doc examples never masquerade as imports (import
 *  specifiers never contain `//`, so string damage is harmless here). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Statically scan source text for static import statements. */
function scanImports(text: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of stripComments(text).matchAll(IMPORT_RE)) {
    out.push({ specifier: m[2]!, typeOnly: Boolean(m[1]) });
  }
  return out;
}

/** `../src/locate/resolve.js` → `src/locate/resolve.ts` (tsx convention:
 *  specifiers use .js, files use .ts). */
function normalizeSrcSpecifier(specifier: string): string {
  if (!specifier.startsWith("../src/")) {
    throw new Error(`not a src specifier: ${specifier}`);
  }
  return `src/${specifier.slice(7).replace(/\.js$/, ".ts")}`;
}

/** Resolve a relative src-internal specifier to a src-relative path. */
function resolveSrcImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  return posix.normalize(`${dir}/${specifier}`).replace(/\.js$/, ".ts");
}

// ---------------------------------------------------------------------------
// The pure completeness checker
// ---------------------------------------------------------------------------

/**
 * Pure completeness checker: given the maps built from disk, return every
 * gap found plus the suite references the coverage table prints. Empty gaps
 * means the ratchet holds. The self-tests below feed it synthetic fixtures
 * to pin each failure mode named in the issue — no repository mutation.
 */
function buildCoverageReport(input: CoverageInput): CoverageReport {
  const gaps: string[] = [];

  // ---- reverse indexes --------------------------------------------------
  const fileSuites: Record<string, string[]> = {};
  const typeOnlySuites: Record<string, string[]> = {};
  const dirSuites: Record<string, string[]> = {};
  const runtimeCovered = new Set<string>();
  for (const [suite, refs] of Object.entries(input.suiteImports)) {
    for (const f of refs.runtime) {
      runtimeCovered.add(f);
      (fileSuites[f] ??= []).push(suite);
      const slash = f.indexOf("/", 4);
      if (slash !== -1) {
        const dir = f.slice(0, slash + 1);
        const arr = dirSuites[dir];
        if (arr) {
          if (!arr.includes(suite)) arr.push(suite);
        } else {
          dirSuites[dir] = [suite];
        }
      }
    }
    for (const f of refs.typeOnly) {
      (typeOnlySuites[f] ??= []).push(suite);
    }
  }
  /** src file → src files that runtime-import it. */
  const srcImporters = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(input.srcRuntimeImports)) {
    for (const t of targets) {
      const arr = srcImporters.get(t);
      if (arr) arr.push(from);
      else srcImporters.set(t, [from]);
    }
  }

  // ---- 1. discovery floor (#46): CI must never run zero suites ----------
  if (input.discoveredSuites.length === 0) {
    gaps.push(
      "no test suites discovered by the glob scripts/test-*.ts — CI would go " +
        "green having run zero tests (the silent hole #46 closed); fix the " +
        "glob or the scripts/ layout",
    );
  }

  // ---- 2. every intent's declared suite exists AND is discovered --------
  for (const intent of Object.values(input.intents)) {
    const base = basename(intent.tests);
    if (!input.declaredSuiteFiles.includes(base)) {
      gaps.push(
        `${intent.file}: tests: ${intent.tests} does not exist — orphaned ` +
          "intent declaration (restore the suite or update the intent)",
      );
    } else if (!input.discoveredSuites.includes(base)) {
      gaps.push(
        `${intent.file}: tests: ${intent.tests} exists but the runner's ` +
          "glob does not discover it — it would never run (named " +
          "test-*.ts? not the excluded harness?)",
      );
    }
  }

  // ---- 3. inventory ↔ intent: no orphans in either direction ------------
  const inventoryModules = new Set([
    ...input.srcDirs,
    ...input.srcTopFiles,
    ...input.entrypoints,
  ]);
  const knownFiles = new Set([
    ...input.srcTopFiles,
    ...Object.values(input.dirFiles).flat(),
  ]);
  for (const dir of input.srcDirs) {
    if (!input.intents[dir]) {
      const name = dir.replace(/^src\//, "").replace(/\/$/, "");
      gaps.push(
        `src/${name}/ has no intent — expected intents/${name}.yml (every ` +
          "src/ directory must declare its contract; see intents/README.md)",
      );
    }
  }
  for (const [module, intent] of Object.entries(input.intents)) {
    if (!inventoryModules.has(module)) {
      gaps.push(
        `${intent.file}: module ${module} is not in the inventory — orphan ` +
          "intent pointing at deleted/renamed code",
      );
    }
  }

  // ---- 4. suite → module orphans ----------------------------------------
  for (const [suite, refs] of Object.entries(input.suiteImports)) {
    for (const target of [...refs.runtime, ...refs.typeOnly]) {
      if (!knownFiles.has(target)) {
        gaps.push(
          `suite ${suite} imports ${target} which does not exist — orphaned ` +
            "suite reference (the module was deleted or renamed; fix the suite)",
        );
      }
    }
  }

  // ---- 5. unclassified scripts/*.ts: nothing enters unreviewed ----------
  const classified = new Set([
    ...input.discoveredSuites,
    "run-tests.ts", // the runner (excluded from discovery by run-tests.ts)
    "test-harness.ts", // the shared helper (same exclusion)
    ...input.entrypoints.map((e) => basename(e)),
  ]);
  for (const f of input.scriptFiles) {
    if (!classified.has(basename(f))) {
      gaps.push(
        `${f} is not a discovered suite, the runner, the harness, or a ` +
          "declared ENTRYPOINT — classify it (add it to ENTRYPOINTS with a " +
          "reason, or make it scripts/test-<name>.ts)",
      );
    }
  }

  // ---- 6. every src module is referenced by a suite (or allowlisted) ----
  for (const dir of input.srcDirs) {
    if ((dirSuites[dir] ?? []).length === 0 && !input.allowlist[dir]) {
      gaps.push(
        `${dir} is not imported by any test suite — a src/ module with no ` +
          "suite is invisible to CI (the PR #36 hole); add a suite or an " +
          "allowlist entry with a reason",
      );
    }
  }
  for (const file of input.srcTopFiles) {
    if (!runtimeCovered.has(file) && !input.allowlist[file]) {
      gaps.push(
        `${file} is not imported by any test suite and is not allowlisted — ` +
          "add a suite that exercises it or an allowlist entry with a reason",
      );
    }
  }
  for (const files of Object.values(input.dirFiles)) {
    for (const file of files) {
      if (!runtimeCovered.has(file) && !input.allowlist[file]) {
        gaps.push(
          `${file} has no direct test-suite import and is not allowlisted — ` +
            "cover it or allowlist it with a reason (it is currently invisible)",
        );
      }
    }
  }

  // ---- 7. status: implemented ⇒ some suite references the module --------
  for (const [module, intent] of Object.entries(input.intents)) {
    if (intent.status !== "implemented") continue;
    const declaredBase = basename(intent.tests);
    const declared = input.discoveredSuites.includes(declaredBase)
      ? declaredBase
      : null;
    const staticRefs = module.endsWith("/")
      ? (dirSuites[module] ?? [])
      : (fileSuites[module] ?? []);
    if (staticRefs.length === 0 && declared === null) {
      gaps.push(
        `${intent.file}: module ${module} is status: implemented but no ` +
          "test suite references it — implement the suite or downgrade the " +
          "intent's status",
      );
    }
  }

  // ---- 8. the allowlist is honest ---------------------------------------
  for (const [module, entry] of Object.entries(input.allowlist)) {
    if (!entry.reason.trim()) {
      gaps.push(
        `ALLOWLIST entry ${module} has no reason — every entry needs one line`,
      );
    }
    if (!inventoryModules.has(module) && !knownFiles.has(module)) {
      gaps.push(`ALLOWLIST entry ${module} does not exist (stale)`);
      continue;
    }
    const direct = module.endsWith("/")
      ? (dirSuites[module] ?? [])
      : (fileSuites[module] ?? []);
    if (direct.length > 0) {
      gaps.push(
        `ALLOWLIST entry ${module} is stale: suite(s) ${direct.join(", ")} ` +
          "now import it directly — remove the entry (the allowlist only " +
          "holds exceptions with no suite)",
      );
      continue;
    }
    if (entry.kind === "type-only") {
      const refs = typeOnlySuites[module] ?? [];
      if (refs.length === 0) {
        gaps.push(
          `ALLOWLIST entry ${module} (type-only) is not even type-referenced ` +
            "by any suite — stale, remove it or give it a real suite",
        );
      }
      const runtimeImporters = srcImporters.get(module) ?? [];
      if (runtimeImporters.length > 0) {
        gaps.push(
          `ALLOWLIST entry ${module} (type-only) is runtime-imported by ` +
            `${runtimeImporters.join(", ")} — its type-only reason no longer ` +
            "holds; give it a real suite",
        );
      }
    } else if (entry.kind === "transitive") {
      const importers = srcImporters.get(module) ?? [];
      if (!importers.some((f) => runtimeCovered.has(f))) {
        gaps.push(
          `ALLOWLIST entry ${module} (transitive) is no longer ` +
            "runtime-imported by any runtime-covered src module — the chain " +
            "is broken; add a real suite or fix the reason",
        );
      }
    } else {
      const targets = input.srcRuntimeImports[module] ?? [];
      if (!targets.some((f) => runtimeCovered.has(f))) {
        gaps.push(
          `ALLOWLIST entry ${module} (entrypoint) no longer imports any ` +
            "runtime-covered src module — verify it still routes to covered code",
        );
      }
    }
  }

  return { gaps, fileSuites, dirSuites, typeOnlySuites };
}

// ---------------------------------------------------------------------------
// The gate — reads the repository from disk, asserts, prints the map
// ---------------------------------------------------------------------------

console.log("triple helix completeness gate (issue #44) — the ratchet\n");

// ---- inventory (read-only: every src/ dir + top file + named CLIs) ------
const srcDirs = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `src/${d.name}/`)
  .sort();
const dirFiles: Record<string, string[]> = {};
for (const dir of srcDirs) {
  const name = dir.slice(4, -1);
  dirFiles[dir] = readdirSync(join(SRC, name))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${name}/${f}`)
    .sort();
}
const srcTopFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `src/${f}`)
  .sort();
const entrypoints = Object.keys(ENTRYPOINTS).sort();
for (const e of entrypoints) {
  assert.ok(
    existsSync(join(ROOT, e)),
    `ENTRYPOINTS lists ${e} which does not exist — stale, remove it`,
  );
}
const scriptFiles = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `scripts/${f}`)
  .sort();
console.log(
  `  inventory: ${srcDirs.length} src/ directories, ` +
    `${srcTopFiles.length} top-level src files, ` +
    `${entrypoints.length} scripts/ entrypoints`,
);

// ---- intents: parsed by #39's parser — imported, never reimplemented ----
const intents: Record<string, IntentInfo> = {};
for (const file of readdirSync(INTENTS_DIR)
  .filter((f) => f.endsWith(".yml"))
  .sort()) {
  const parsed: Intent = parseIntentYaml(
    readFileSync(join(INTENTS_DIR, file), "utf8"),
  );
  const module = String(parsed.module ?? "");
  intents[module] = {
    file: `intents/${file}`,
    id: String(parsed.id ?? ""),
    status: String(parsed.status ?? ""),
    tests: String(parsed.tests ?? ""),
  };
}
console.log(
  `  intents: ${Object.keys(intents).length} parsed via parseIntentYaml ` +
    `(imported from test-intents.ts — not reimplemented)`,
);

// ---- suites + their static src imports (scan, no instrumentation) -------
const GATE_FILE = basename(import.meta.url); // this suite — see docblock
const suitePaths = discoverSuites(SCRIPTS);
const discoveredSuites = suitePaths.map((p) => basename(p));
const suiteImports: Record<string, SuiteImports> = {};
for (const path of suitePaths) {
  if (basename(path) === GATE_FILE) continue; // no src imports by design
  const refs: SuiteImports = { runtime: [], typeOnly: [] };
  for (const imp of scanImports(readFileSync(path, "utf8"))) {
    if (!imp.specifier.startsWith("../src/")) continue;
    const module = normalizeSrcSpecifier(imp.specifier);
    (imp.typeOnly ? refs.typeOnly : refs.runtime).push(module);
  }
  suiteImports[basename(path)] = refs;
}
console.log(
  `  suites: ${discoveredSuites.length} discovered ` +
    `(glob scripts/test-*.ts), ${Object.keys(suiteImports).length} scanned ` +
    "for src imports (type-only imports excluded from coverage)",
);

// ---- src-internal runtime import graph (transitive verification) --------
const srcRuntimeImports: Record<string, string[]> = {};
for (const file of [...srcTopFiles, ...Object.values(dirFiles).flat()]) {
  const targets: string[] = [];
  for (const imp of scanImports(readFileSync(join(ROOT, file), "utf8"))) {
    if (imp.typeOnly) continue;
    const target = resolveSrcImport(file, imp.specifier);
    if (target?.startsWith("src/") && !targets.includes(target)) {
      targets.push(target);
    }
  }
  if (targets.length > 0) srcRuntimeImports[file] = targets;
}

// ---- declared tests: basenames whose file exists on disk ----------------
const declaredSuiteFiles = [
  ...new Set(
    Object.values(intents)
      .map((i) => i.tests)
      .filter((t) => existsSync(join(ROOT, t)))
      .map((t) => basename(t)),
  ),
];

const report = buildCoverageReport({
  srcDirs,
  dirFiles,
  srcTopFiles,
  entrypoints,
  intents,
  suiteImports,
  srcRuntimeImports,
  discoveredSuites,
  scriptFiles,
  declaredSuiteFiles,
  allowlist: ALLOWLIST,
});

// ---- coverage table: the artifact an agent consults first ---------------
interface Row {
  module: string;
  intent: string;
  suites: string;
  status: string;
}

/** The suites cell for a module with no direct runtime suite import. */
function fallbackSuites(module: string): string {
  const entry = ALLOWLIST[module];
  if (entry) return `⊘ allowlisted (${entry.kind})`;
  return "—";
}

/** The suite an entrypoint module covers through its intent's tests: field. */
function declaredSuiteOf(intent: IntentInfo | undefined): string | null {
  if (!intent) return null;
  const base = basename(intent.tests);
  return discoveredSuites.includes(base) ? base : null;
}

console.log("\ncoverage map — module → intent → suites → status\n");
const rows: Row[] = [];
for (const dir of srcDirs) {
  const intent = intents[dir];
  const suites = report.dirSuites[dir] ?? [];
  rows.push({
    module: dir,
    intent: intent ? intent.id : "—",
    suites: suites.length > 0 ? suites.join(", ") : fallbackSuites(dir),
    status: intent ? intent.status : "—",
  });
}
for (const file of srcTopFiles) {
  const intent = intents[file];
  const suites = report.fileSuites[file] ?? [];
  rows.push({
    module: file,
    intent: intent ? intent.id : "—",
    suites: suites.length > 0 ? suites.join(", ") : fallbackSuites(file),
    status: intent ? intent.status : "—",
  });
}
for (const e of entrypoints) {
  const intent = intents[e];
  const declared = declaredSuiteOf(intent);
  rows.push({
    module: e,
    intent: intent ? intent.id : "—",
    suites: declared ? `${declared} (via intent)` : fallbackSuites(e),
    status: intent ? intent.status : "—",
  });
}

const colWidth = (header: string, pick: (r: Row) => string): number =>
  Math.max(header.length, ...rows.map(pick));
const wModule = colWidth("module", (r) => r.module);
const wIntent = colWidth("intent", (r) => r.intent);
const wSuites = colWidth("suites", (r) => r.suites);
const wStatus = colWidth("status", (r) => r.status);
const rule = (n: number): string => "─".repeat(n);
console.log(
  `${"module".padEnd(wModule)}  ${"intent".padEnd(wIntent)}  ` +
    `${"suites".padEnd(wSuites)}  ${"status"}`,
);
console.log(
  `${rule(wModule)}  ${rule(wIntent)}  ${rule(wSuites)}  ${rule(wStatus)}`,
);
for (const r of rows) {
  console.log(
    `${r.module.padEnd(wModule)}  ${r.intent.padEnd(wIntent)}  ` +
      `${r.suites.padEnd(wSuites)}  ${r.status}`,
  );
}

// ---- per-file detail: where the allowlist lives --------------------------
function printFileLine(file: string): void {
  const suites = report.fileSuites[file] ?? [];
  const entry = ALLOWLIST[file];
  if (suites.length > 0) {
    console.log(`    ✓ ${file} — ${suites.join(", ")}`);
  } else if (entry) {
    console.log(`    ⊘ ${file} — ${entry.kind}: ${entry.reason}`);
  } else {
    console.log(`    ? ${file} — no direct suite (the gate names this above)`);
  }
}

console.log("\nper-file suite coverage (✓ direct · ⊘ allowlisted)");
for (const dir of srcDirs) {
  console.log(`  ${dir}`);
  for (const file of dirFiles[dir] ?? []) {
    printFileLine(file);
  }
}
console.log("  top-level src files");
for (const file of srcTopFiles) {
  printFileLine(file);
}

// ---- the ratchet verdict -------------------------------------------------
if (report.gaps.length > 0) {
  console.log(
    `\n✖ the ratchet is broken — ${report.gaps.length} coverage gap(s):`,
  );
  for (const g of report.gaps) console.log(`  ✖ ${g}`);
  assert.fail(
    `${report.gaps.length} coverage-map gap(s) — see the ✖ lines above`,
  );
}
console.log(
  `\n  ✓ discovery floor: ${discoveredSuites.length} suites ≥ ` +
    `${new Set(declaredSuiteFiles).size} declared by intents — CI can ` +
    "never run zero tests (issue #46)",
);
console.log(
  `  ✓ inventory ↔ intents: ${srcDirs.length} src/ directories ↔ ` +
    `${Object.keys(intents).length} intents, no orphans either way`,
);
console.log(
  `  ✓ coverage: every src/ module is imported by a suite or allowlisted ` +
    `(${Object.keys(ALLOWLIST).length} exceptions, all verified)`,
);
console.log(
  `  ✓ every status: implemented intent has a suite reference; consult ` +
    "the coverage map above before touching a module",
);

// ===========================================================================
// Ratchet self-tests: synthetic fixtures pin each failure mode named in
// issue #44 — no repository mutation, no tmp files, pure functions only.
// ===========================================================================

/** A minimal complete repository: two dirs, one top file, one entrypoint,
 *  three suites — the happy path the checker must accept. The beta dir also
 *  carries an allowlisted internal helper verified transitively. */
function validFixture(): CoverageInput {
  return {
    srcDirs: ["src/alpha/", "src/beta/"],
    dirFiles: {
      "src/alpha/": ["src/alpha/core.ts"],
      "src/beta/": ["src/beta/helper.ts", "src/beta/internal.ts"],
    },
    srcTopFiles: ["src/config.ts"],
    entrypoints: ["scripts/tool.ts"],
    intents: {
      "src/alpha/": {
        file: "intents/alpha.yml",
        id: "feedflag.intent/alpha@1",
        status: "implemented",
        tests: "scripts/test-alpha.ts",
      },
      "src/beta/": {
        file: "intents/beta.yml",
        id: "feedflag.intent/beta@1",
        status: "implemented",
        tests: "scripts/test-beta.ts",
      },
    },
    suiteImports: {
      "test-alpha.ts": { runtime: ["src/alpha/core.ts"], typeOnly: [] },
      "test-beta.ts": { runtime: ["src/beta/helper.ts"], typeOnly: [] },
      "test-config.ts": { runtime: ["src/config.ts"], typeOnly: [] },
    },
    srcRuntimeImports: {
      "src/config.ts": ["src/alpha/core.ts"],
      "src/beta/helper.ts": ["src/beta/internal.ts"],
    },
    discoveredSuites: ["test-alpha.ts", "test-beta.ts", "test-config.ts"],
    scriptFiles: [
      "test-alpha.ts",
      "test-beta.ts",
      "test-config.ts",
      "run-tests.ts",
      "test-harness.ts",
    ],
    declaredSuiteFiles: ["test-alpha.ts", "test-beta.ts"],
    allowlist: {
      "src/beta/internal.ts": {
        kind: "transitive",
        reason: "internal helper used only by src/beta/helper.ts",
      },
    },
  };
}

{
  assert.deepEqual(buildCoverageReport(validFixture()).gaps, []);
  console.log("  ✓ self-test: a complete miniature repo has zero gaps");
}

{
  // A brand-new src/ directory with no intent and no suite: both named.
  const input = validFixture();
  input.srcDirs.push("src/probe/");
  input.dirFiles["src/probe/"] = ["src/probe/probe.ts"];
  const { gaps } = buildCoverageReport(input);
  const intentNote = "src/probe/ has no intent";
  const intentGap = gaps.find((g) => g.includes(intentNote));
  assert.ok(intentGap, "the gate names the missing intent");
  const suiteNote = "src/probe/ is not imported by any test suite";
  const suiteGap = gaps.find((g) => g.includes(suiteNote));
  assert.ok(suiteGap, "the gate names the missing suite");
  console.log("  ✓ self-test: a new src/ dir fails, naming both gaps");
}

{
  // An intent whose tests: path does not exist (orphaned declaration).
  const input = validFixture();
  input.intents["src/alpha/"].tests = "scripts/test-gone.ts";
  const { gaps } = buildCoverageReport(input);
  const gap = gaps.find((g) => g.includes("test-gone.ts"));
  assert.ok(gap, "the orphaned declaration is named");
  assert.ok(
    gap?.includes("intents/alpha.yml"),
    "the gap names the intent file that declares the missing suite",
  );
  console.log("  ✓ self-test: an intent naming a missing suite file fails");
}

{
  // A declared suite that exists but the runner's glob never discovers.
  const input = validFixture();
  input.intents["src/beta/"].tests = "scripts/test-harness.ts";
  input.declaredSuiteFiles.push("test-harness.ts");
  const { gaps } = buildCoverageReport(input);
  const note = "does not discover it";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "a declared-but-undiscovered suite is named",
  );
  console.log("  ✓ self-test: an undiscovered declared suite fails");
}

{
  // A suite importing a module that no longer exists (orphan direction 2).
  const input = validFixture();
  input.suiteImports["test-alpha.ts"].runtime.push("src/gone/deleted.ts");
  const { gaps } = buildCoverageReport(input);
  const note = "src/gone/deleted.ts";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "a suite referencing a deleted module is named",
  );
  console.log("  ✓ self-test: a suite naming a deleted module fails");
}

{
  // An intent whose module is gone (orphan direction 1): file and module.
  const input = validFixture();
  input.intents["src/gone/"] = {
    file: "intents/gone.yml",
    id: "feedflag.intent/gone@1",
    status: "implemented",
    tests: "scripts/test-alpha.ts",
  };
  const { gaps } = buildCoverageReport(input);
  const note = "not in the inventory";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "an orphan intent pointing at deleted code is named",
  );
  assert.ok(
    gaps.some((g) => g.includes("intents/gone.yml")),
    "the gap names the orphaned intent file",
  );
  console.log("  ✓ self-test: an intent naming a deleted module fails");
}

{
  // status: implemented but no suite references the module at all.
  const input = validFixture();
  delete input.suiteImports["test-beta.ts"];
  input.intents["src/beta/"].tests = "scripts/test-gone.ts";
  const { gaps } = buildCoverageReport(input);
  const note = "is status: implemented but no test suite references it";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "an implemented module without a suite is named",
  );
  console.log("  ✓ self-test: implemented without a suite fails");
}

{
  // An allowlist entry whose module has since gained a direct suite.
  const input = validFixture();
  input.allowlist["src/beta/helper.ts"] = {
    kind: "transitive",
    reason: "was internal before test-beta.ts existed",
  };
  const { gaps } = buildCoverageReport(input);
  const note = "is stale: suite(s) test-beta.ts now import it directly";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "a stale allowlist entry is named for removal",
  );
  console.log("  ✓ self-test: a stale allowlist entry fails");
}

{
  // A transitive allowlist entry whose importer lost suite coverage.
  const input = validFixture();
  delete input.srcRuntimeImports["src/beta/helper.ts"];
  const { gaps } = buildCoverageReport(input);
  const note = "no longer runtime-imported by any runtime-covered";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "a broken coverage chain is named",
  );
  console.log("  ✓ self-test: a broken transitive chain fails");
}

{
  // The #46 silent hole: the discovery glob finds nothing at all.
  const input = validFixture();
  input.discoveredSuites = [];
  input.suiteImports = {};
  const { gaps } = buildCoverageReport(input);
  const note = "no test suites discovered";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "an empty discovery set fails the gate",
  );
  console.log("  ✓ self-test: zero discovered suites fails (issue #46)");
}

{
  // A scripts/*.ts file that is none of: suite, runner, harness, entrypoint.
  const input = validFixture();
  input.scriptFiles.push("scripts/backfill.ts");
  const { gaps } = buildCoverageReport(input);
  const note = "scripts/backfill.ts is not a discovered suite";
  assert.ok(
    gaps.some((g) => g.includes(note)),
    "an unclassified script is named for classification",
  );
  console.log("  ✓ self-test: an unclassified script file fails");
}

{
  // The scanner: runtime vs type-only, single- and multi-line imports.
  const refs = scanImports(
    [
      'import { settings } from "../src/config.js";',
      'import type { FlaggedItem } from "../src/types.js";',
      "import {",
      "  NO_MATCH,",
      "  type ResolveInput,",
      '} from "../src/locate/resolve.js";',
    ].join("\n"),
  );
  const runtime = refs.filter((r) => !r.typeOnly).map((r) => r.specifier);
  assert.deepEqual(runtime, ["../src/config.js", "../src/locate/resolve.js"]);
  const typeOnly = refs.filter((r) => r.typeOnly).map((r) => r.specifier);
  assert.deepEqual(typeOnly, ["../src/types.js"]);
  console.log("  ✓ self-test: runtime vs type-only imports classified");
}

{
  // Comments never masquerade as imports in the static scan.
  const refs = scanImports(
    [
      '// import { fake } from "../src/fake.js";',
      '/* import { alsoFake } from "../src/also-fake.js"; */',
      'import { real } from "../src/real.js";',
    ].join("\n"),
  );
  assert.deepEqual(
    refs.map((r) => r.specifier),
    ["../src/real.js"],
  );
  console.log("  ✓ self-test: comments never masquerade as imports");
}

{
  // Specifier normalisation: ../src/foo/bar.js → src/foo/bar.ts.
  assert.equal(normalizeSrcSpecifier("../src/config.js"), "src/config.ts");
  assert.equal(
    normalizeSrcSpecifier("../src/locate/resolve.js"),
    "src/locate/resolve.ts",
  );
  assert.throws(
    () => normalizeSrcSpecifier("./config.js"),
    "non-src specifiers are rejected",
  );
  console.log("  ✓ self-test: ../src/x.js normalises to src/x.ts");
}

{
  // Relative src-internal specifiers resolve to src/ paths.
  assert.equal(
    resolveSrcImport("src/locate/resolve.ts", "./candidates.js"),
    "src/locate/candidates.ts",
  );
  assert.equal(
    resolveSrcImport("src/emit/records.ts", "../config.js"),
    "src/config.ts",
  );
  assert.equal(resolveSrcImport("src/util.ts", "node:fs"), null);
  console.log("  ✓ self-test: relative specifiers resolve in src/");
}
