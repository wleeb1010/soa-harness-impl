#!/usr/bin/env node
/*
 * Codegen for @soa-harness/schemas.
 *
 * Pipeline (after E1 vendoring fix):
 *   1. Read soa-validate.lock to discover the pinned spec commit.
 *   2. If src/schemas/vendored/PINNED_COMMIT.txt matches that pin AND
 *      SOA_SCHEMAS_FORCE_REFRESH is not set → use vendored schemas as
 *      source of truth. This is the fresh-clone path; no sibling repo
 *      needed.
 *   3. Otherwise → require the sibling ../soa-harness=specification/ repo
 *      checked out at the pinned commit; re-vendor from there. This is
 *      the pin-bump workflow (or explicit refresh).
 *   4. Sanity-compile every schema with Ajv 2020-12 so any breakage
 *      surfaces before a downstream consumer loads the registry.
 *   5. Emit src/registry.ts — a typed Ajv 2020-12 registry that loads the
 *      vendored schemas and compiles them at module load time. (Runtime
 *      compile rather than standalone codegen — Ajv's standalone ESM
 *      output still emits `require("ajv-formats/dist/formats")` which
 *      breaks in ESM consumers. 29 small schemas compile in sub-ms; the
 *      90-second demo budget has room.)
 *
 * Fails loudly if the pin-bump path is entered and the sibling is
 * missing / on the wrong commit, or if any schema fails to compile.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
  existsSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const specRoot = join(repoRoot, "..", "soa-harness=specification");
const vendoredDir = join(pkgRoot, "src", "schemas", "vendored");
const pinnedCommitFile = join(vendoredDir, "PINNED_COMMIT.txt");
const forceRefresh = process.env.SOA_SCHEMAS_FORCE_REFRESH === "1";

function die(msg) {
  console.error(`\n[schemas/build-validators] ${msg}\n`);
  process.exit(1);
}

// 1. Read pin.
const lockPath = join(repoRoot, "soa-validate.lock");
if (!existsSync(lockPath)) die(`soa-validate.lock not found at ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const pinnedSha = lock.spec_commit_sha;
if (!pinnedSha) die("soa-validate.lock has no spec_commit_sha");

// 2. Decide: vendored path vs sibling-refresh path.
let vendoredSha = null;
if (existsSync(pinnedCommitFile)) {
  vendoredSha = readFileSync(pinnedCommitFile, "utf8").trim();
}

const pinMatches = vendoredSha === pinnedSha;
const useVendored = pinMatches && !forceRefresh;

if (useVendored) {
  console.log(
    `[schemas] using vendored schemas at pinned commit ${pinnedSha.slice(0, 12)} (no sibling spec repo needed)`
  );
} else {
  // Sibling-refresh path. Hit when: (a) pin bumped but vendored not yet refreshed,
  // (b) fresh checkout where someone deleted vendored/, (c) SOA_SCHEMAS_FORCE_REFRESH=1.
  const reason = forceRefresh
    ? "SOA_SCHEMAS_FORCE_REFRESH=1 — forcing re-vendor"
    : vendoredSha === null
      ? "no vendored schemas found (first-time bootstrap or deleted)"
      : `vendored pin ${vendoredSha.slice(0, 12)} does not match soa-validate.lock pin ${pinnedSha.slice(0, 12)} — pin bump flow`;
  console.log(`[schemas] re-vendoring from sibling spec repo: ${reason}`);

  if (!existsSync(specRoot)) {
    die(
      `Sibling spec repo not found at ${specRoot}\n\n` +
        `  The re-vendor path requires the sibling soa-harness-specification repo\n` +
        `  checked out at the pinned commit ${pinnedSha.slice(0, 12)}. Fresh\n` +
        `  clones do NOT need this — the vendored schemas in src/schemas/vendored/\n` +
        `  are tracked in git and used automatically when the pin matches.\n\n` +
        `  If you are bumping the pin: clone the spec repo as a sibling, check\n` +
        `  out the new commit, then re-run this script.\n` +
        `  If you are a fresh contributor and hit this error: your tree is\n` +
        `  missing src/schemas/vendored/ — run 'git checkout -- packages/schemas/src/schemas/vendored/' to restore.`
    );
  }

  let actualSha;
  try {
    actualSha = execSync("git rev-parse HEAD", { cwd: specRoot, encoding: "utf8" }).trim();
  } catch (err) {
    die(`Could not read HEAD of sibling spec repo at ${specRoot}: ${err.message}`);
  }
  if (actualSha !== pinnedSha) {
    die(
      `Sibling spec repo is at ${actualSha.slice(0, 12)} but soa-validate.lock pins ${pinnedSha.slice(0, 12)}.\n` +
        `Run: (cd ${specRoot} && git fetch && git checkout ${pinnedSha})\n` +
        `Or bump the pin via the protocol in soa-validate.lock.pin_bump_protocol.`
    );
  }

  const srcSchemasDir = join(specRoot, "schemas");
  if (!existsSync(srcSchemasDir)) die(`Spec has no schemas/ directory at ${srcSchemasDir}`);
  rmSync(vendoredDir, { recursive: true, force: true });
  mkdirSync(vendoredDir, { recursive: true });
  const sourceSchemas = readdirSync(srcSchemasDir).filter((f) => f.endsWith(".schema.json"));
  if (sourceSchemas.length === 0) die(`No *.schema.json files in ${srcSchemasDir}`);
  for (const f of sourceSchemas) {
    cpSync(join(srcSchemasDir, f), join(vendoredDir, f));
  }
  writeFileSync(pinnedCommitFile, `${pinnedSha}\n`);
  console.log(
    `[schemas] vendored ${sourceSchemas.length} schemas from sibling (spec ${pinnedSha.slice(0, 12)})`
  );
}

// 3. Load + sanity-compile.
if (!existsSync(vendoredDir)) {
  die(`Vendored schemas directory missing at ${vendoredDir} even after re-vendor — aborting`);
}
const schemaFiles = readdirSync(vendoredDir).filter((f) => f.endsWith(".schema.json"));
if (schemaFiles.length === 0) {
  die(`No *.schema.json files in ${vendoredDir} — vendoring produced an empty directory`);
}
const Ajv = Ajv2020.default ?? Ajv2020;
const addFormatsFn = addFormats.default ?? addFormats;

const loaded = schemaFiles.map((f) => {
  const schema = JSON.parse(readFileSync(join(vendoredDir, f), "utf8"));
  const id = schema.$id ?? f;
  return { file: f, name: f.replace(/\.schema\.json$/, ""), id, schema };
});

const sanityAjv = new Ajv({ strict: false, allowUnionTypes: true });
addFormatsFn(sanityAjv);
for (const { id, schema } of loaded) sanityAjv.addSchema(schema, id);
for (const { id, name } of loaded) {
  if (!sanityAjv.getSchema(id)) die(`Ajv could not resolve $id=${id} for ${name} during sanity compile`);
}

// Clean any prior standalone codegen artefacts (earlier build of this script).
rmSync(join(pkgRoot, "src", "validators"), { recursive: true, force: true });
rmSync(join(pkgRoot, "dist", "validators"), { recursive: true, force: true });

// 4. Emit registry.ts.
function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
const importLines = loaded.map(
  ({ file, name }) => `import ${camel(name)}Schema from "./schemas/vendored/${file}" with { type: "json" };`
);
const addLines = loaded.map(
  ({ name }) =>
    `ajv.addSchema(${camel(name)}Schema as Record<string, unknown>, (${camel(name)}Schema as { $id?: string }).$id ?? "${name}");`
);
const registryEntries = loaded.map(({ name }) => {
  const idExpr = `(${camel(name)}Schema as { $id?: string }).$id ?? "${name}"`;
  return `  "${name}": (ajv.getSchema(${idExpr}) ?? ajv.compile(${camel(name)}Schema)) as Validator,`;
});

const registry = [
  "// AUTO-GENERATED by scripts/build-validators.mjs. Do not edit.",
  `// Pinned spec commit: ${pinnedSha}`,
  'import * as Ajv2020Module from "ajv/dist/2020.js";',
  'import * as addFormatsModule from "ajv-formats";',
  'import type { ValidateFunction } from "ajv";',
  ...importLines,
  "",
  "export type Validator = ValidateFunction<unknown>;",
  "",
  "// ajv 8 ships CJS with a default export. ESM/TS interop requires resolving .default",
  "// explicitly because different bundlers handle the namespace differently.",
  "const AjvCtor = (Ajv2020Module as unknown as { default: new (opts?: unknown) => unknown }).default;",
  "const addFormatsFn = (addFormatsModule as unknown as { default: (ajv: unknown) => unknown }).default;",
  "",
  "const ajv = new AjvCtor({ strict: false, allowUnionTypes: true }) as {",
  "  addSchema(schema: unknown, key?: string): unknown;",
  "  getSchema(key: string): ValidateFunction | undefined;",
  "  compile(schema: unknown): ValidateFunction;",
  "};",
  "addFormatsFn(ajv);",
  "",
  ...addLines,
  "",
  "export const registry = {",
  ...registryEntries,
  "} as const;",
  "",
  "export type SchemaName = keyof typeof registry;",
  "export const schemaNames = Object.keys(registry) as SchemaName[];",
  "",
  `export const PINNED_SPEC_COMMIT = ${JSON.stringify(pinnedSha)} as const;`,
  ""
].join("\n");
writeFileSync(join(pkgRoot, "src", "registry.ts"), registry);

console.log(
  `[schemas] emitted registry.ts with ${loaded.length} runtime-compiled validators (spec ${pinnedSha.slice(0, 12)})`
);
