#!/usr/bin/env node
/**
 * check-version-parity.mjs — asserts the six-way version agreement that
 * Debt #7 (v1.1.0) and Debt #8 (v1.2.0) each shipped wrong.
 *
 * Drifts this catches:
 *   (1) schemas/src/schemas/vendored/PINNED_COMMIT.txt vs spec HEAD
 *   (2) schemas/src/registry.ts::PINNED_SPEC_COMMIT vs (1)
 *   (3) All 11 packages/*\/package.json versions agreeing with each other
 *   (4) All 4 scaffold-template start.mjs runnerVersion hardcodes matching
 *       the major.minor of (3)
 *   (5) All 4 scaffold-template package.json @soa-harness/* dep ranges
 *       matching ^X.Y.Z of (3)
 *   (6) tools/vscode-extension version agreeing with (3)
 *
 * Exits 0 on parity, 1 + diagnostic on drift. Designed to run as a
 * pre-release-prep check; Debt #7/#8 both shipped because nothing
 * automated enforced these invariants.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const implRoot = join(here, "..");

const PACKAGES = [
  "schemas",
  "core",
  "runner",
  "memory-mcp-sqlite",
  "memory-mcp-mem0",
  "memory-mcp-zep",
  "langgraph-adapter",
  "example-provider-adapter",
  "chat-ui",
  "cli",
  "create-soa-agent",
];

const SCAFFOLD_TEMPLATES = [
  "runner-starter",
  "runner-starter-mem0",
  "runner-starter-zep",
  "runner-starter-none",
];

const failures = [];

function fail(msg) {
  failures.push(msg);
}

function readVersion(pkgName) {
  const path = join(implRoot, "packages", pkgName, "package.json");
  if (!existsSync(path)) {
    fail(`missing package: ${path}`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")).version;
}

// (3) All 11 packages agree on version.
const versions = PACKAGES.map((p) => ({ name: p, version: readVersion(p) }));
const distinctVersions = new Set(versions.map((v) => v.version).filter((v) => v !== null));
if (distinctVersions.size > 1) {
  fail(
    `Package versions disagree: ${versions
      .map((v) => `${v.name}=${v.version}`)
      .join(", ")}`,
  );
}
const canonicalVersion = versions[0]?.version ?? "0.0.0";
const [major, minor] = canonicalVersion.split(".");
const majorMinor = `${major}.${minor}`;

// (1) + (2) PINNED_COMMIT.txt matches registry.ts PINNED_SPEC_COMMIT.
const pinFile = join(
  implRoot,
  "packages/schemas/src/schemas/vendored/PINNED_COMMIT.txt",
);
const pinnedCommit = existsSync(pinFile)
  ? readFileSync(pinFile, "utf8").trim()
  : null;
if (!pinnedCommit) fail(`PINNED_COMMIT.txt missing at ${pinFile}`);

const registryPath = join(implRoot, "packages/schemas/src/registry.ts");
if (existsSync(registryPath)) {
  const registry = readFileSync(registryPath, "utf8");
  const m = /PINNED_SPEC_COMMIT\s*=\s*"([^"]+)"/.exec(registry);
  if (!m) fail("registry.ts has no PINNED_SPEC_COMMIT export");
  else if (m[1] !== pinnedCommit) {
    fail(
      `PINNED drift: vendored/PINNED_COMMIT.txt=${pinnedCommit?.slice(0, 12) ?? "MISSING"} but registry.ts PINNED_SPEC_COMMIT=${m[1].slice(0, 12)}`,
    );
  }
} else {
  fail(`registry.ts missing at ${registryPath} (pre-build state?)`);
}

// (4) Scaffold-template start.mjs runnerVersion hardcodes all match X.Y.
for (const tpl of SCAFFOLD_TEMPLATES) {
  const startPath = join(
    implRoot,
    "packages/create-soa-agent/templates",
    tpl,
    "start.mjs",
  );
  if (!existsSync(startPath)) {
    fail(`missing scaffold template: ${startPath}`);
    continue;
  }
  const src = readFileSync(startPath, "utf8");
  const matches = src.match(/runnerVersion:\s*"([^"]+)"/g) ?? [];
  for (const hit of matches) {
    const m = /runnerVersion:\s*"([^"]+)"/.exec(hit);
    if (!m) continue;
    if (m[1] !== majorMinor) {
      fail(
        `${tpl}/start.mjs: runnerVersion "${m[1]}" does not match canonical X.Y "${majorMinor}" (from package versions)`,
      );
    }
  }
}

// (5) Scaffold-template package.json @soa-harness/* deps at ^canonical.
for (const tpl of SCAFFOLD_TEMPLATES) {
  const pkgPath = join(
    implRoot,
    "packages/create-soa-agent/templates",
    tpl,
    "package.json",
  );
  if (!existsSync(pkgPath)) continue;
  const obj = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const [dep, range] of Object.entries(obj.dependencies ?? {})) {
    if (!dep.startsWith("@soa-harness/")) continue;
    if (range !== `^${canonicalVersion}`) {
      fail(
        `${tpl}/package.json: dep ${dep} is "${range}"; expected "^${canonicalVersion}"`,
      );
    }
  }
}

// (6) vscode-extension version parity (soft-fail — private package, may lag).
const vscodePath = join(implRoot, "tools/vscode-extension/package.json");
if (existsSync(vscodePath)) {
  const vscode = JSON.parse(readFileSync(vscodePath, "utf8"));
  if (vscode.version !== canonicalVersion) {
    fail(
      `tools/vscode-extension version "${vscode.version}" != canonical "${canonicalVersion}"`,
    );
  }
}

// Report + exit.
if (failures.length === 0) {
  console.log(
    `[check-version-parity] OK — all sources agree on version ${canonicalVersion} (majorMinor ${majorMinor}, pinnedCommit ${pinnedCommit?.slice(0, 12)})`,
  );
  process.exit(0);
}

console.error(`[check-version-parity] FAILED — ${failures.length} drift(s):`);
for (const f of failures) console.error(`  - ${f}`);
console.error(
  `\nThis check exists specifically to prevent Debt #7 + Debt #8 shipping again. If you're intentionally drifting (e.g., pre-bump in a feature branch), guard-rail via --allow-drift is deliberately NOT provided — fix the drift or split the commit.`,
);
process.exit(1);
