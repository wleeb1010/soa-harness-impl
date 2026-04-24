#!/usr/bin/env node
/**
 * conform.mjs — scaffold-shipped conformance probe runner.
 *
 * Runs `soa-validate` against a live Runner (default http://127.0.0.1:7700)
 * with the pinned spec-vectors path. Exits 0 when the validator reports
 * zero failures; non-zero otherwise.
 *
 * Options (env):
 *   SOA_IMPL_URL                 base URL of the Runner under test (default http://127.0.0.1:7700)
 *   SOA_RUNNER_BOOTSTRAP_BEARER  bootstrap bearer the Runner was started with (optional; live probes
 *                                requiring session bootstrap skip if unset)
 *   SOA_SPEC_VECTORS             path to a checkout of the spec repo at the pinned commit.
 *                                Falls back to ../soa-harness-specification or ./spec-vectors
 *                                if unset.
 *
 * Prerequisite: soa-validate binary on PATH. Install with:
 *   go install github.com/wleeb1010/soa-validate/cmd/soa-validate@latest
 *
 * Or download a release binary from:
 *   https://github.com/wleeb1010/soa-validate/releases
 *
 * The conform script does NOT spawn the Runner — it expects you to have
 * `npm start` in another terminal OR to have a Runner running elsewhere
 * pointed to by SOA_IMPL_URL.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const IMPL_URL = process.env.SOA_IMPL_URL || "http://127.0.0.1:7700";
const BEARER = process.env.SOA_RUNNER_BOOTSTRAP_BEARER || "";
const SPEC_VECTORS = resolveSpecVectors();
const PROFILE = process.env.SOA_PROFILE || "core";

function resolveSpecVectors() {
  if (process.env.SOA_SPEC_VECTORS) return process.env.SOA_SPEC_VECTORS;
  const candidates = [
    "../soa-harness-specification",
    "../soa-harness=specification",
    "./spec-vectors",
    "./soa-harness-specification",
  ];
  for (const c of candidates) {
    const abs = resolve(c);
    if (existsSync(`${abs}/soa-validate-must-map.json`)) return abs;
  }
  return null;
}

function findBinary(name) {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [name], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function printInstallHelp() {
  console.error(`
soa-validate not found on PATH.

Install via Go toolchain (requires Go >=1.22):
  go install github.com/wleeb1010/soa-validate/cmd/soa-validate@latest
  # then ensure $(go env GOPATH)/bin is on PATH

Or download a release binary:
  https://github.com/wleeb1010/soa-validate/releases

Once installed, run \`npm run conform\` again.
  `.trim());
}

function main() {
  const bin = findBinary("soa-validate") || findBinary("soa-validate.exe");
  if (!bin) {
    printInstallHelp();
    process.exit(2);
  }
  if (!SPEC_VECTORS) {
    console.error(`
Could not find a spec-vectors path. Set SOA_SPEC_VECTORS to a checkout of
https://github.com/wleeb1010/soa-harness-specification at the commit
matching your installed @soa-harness/runner version (check your
soa-validate.lock if present).

Quick option:
  git clone https://github.com/wleeb1010/soa-harness-specification ../soa-harness-specification
  npm run conform
    `.trim());
    process.exit(2);
  }

  console.log(`[conform] soa-validate: ${bin}`);
  console.log(`[conform] impl URL:     ${IMPL_URL}`);
  console.log(`[conform] spec:         ${SPEC_VECTORS}`);
  console.log(`[conform] profile:      ${PROFILE}`);
  console.log("");

  const args = [
    "--impl-url", IMPL_URL,
    "--spec-vectors", SPEC_VECTORS,
    "--profile", PROFILE,
    "--out", "release-gate.json",
  ];
  const env = { ...process.env };
  if (BEARER) env.SOA_RUNNER_BOOTSTRAP_BEARER = BEARER;

  try {
    execFileSync(bin, args, { stdio: "inherit", env });
    console.log("\n[conform] validator reported no failures — conformance OK for profile=" + PROFILE);
    process.exit(0);
  } catch (err) {
    const code = typeof err?.status === "number" ? err.status : 1;
    console.error(`\n[conform] validator exited with code ${code}. See release-gate.json for detail.`);
    process.exit(code);
  }
}

main();
