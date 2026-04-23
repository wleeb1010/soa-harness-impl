#!/usr/bin/env node
/**
 * Smoke tests for scripts/release-gate.mjs — hand-rolled so it runs
 * under plain node without vitest / ESM testing harness setup.
 *
 * Three cases:
 *   1. all_green=true report → exit 0
 *   2. non-green but every non-pass cell has waiver_reference → exit 0
 *   3. non-green with an unwaived cell → exit 1
 *
 * Run: node scripts/release-gate.test.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "release-gate.mjs");

function runGate(reportPath) {
  return spawnSync(process.execPath, [GATE, reportPath], { encoding: "utf8" });
}

function writeReport(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("PASS:", msg);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "release-gate-test-"));
try {
  // Case 1: all_green.
  const p1 = writeReport(tmp, "all-green.json", {
    backend: "sqlite",
    generated_at: "2026-04-23T00:00:00Z",
    summary: { all_green: true },
    cells: [{ test_id: "SV-MEM-01", result: "pass" }],
  });
  const r1 = runGate(p1);
  assert(r1.status === 0, "all_green=true → exit 0");

  // Case 2: all non-pass cells waived.
  const p2 = writeReport(tmp, "all-waived.json", {
    backend: "mem0",
    generated_at: "2026-04-23T00:00:00Z",
    summary: { all_green: false, waived: true },
    cells: [
      { test_id: "SV-MEM-01", result: "pass" },
      {
        test_id: "SV-MEM-04",
        result: "skip",
        waiver_reference: "docs/m5/waivers/2026-04-23-mem0-degraded.md",
      },
    ],
  });
  const r2 = runGate(p2);
  assert(r2.status === 0, "all non-pass cells carry waiver_reference → exit 0");

  // Case 3: one non-pass cell without waiver.
  const p3 = writeReport(tmp, "unwaived.json", {
    backend: "zep",
    generated_at: "2026-04-23T00:00:00Z",
    summary: { all_green: false },
    cells: [
      { test_id: "SV-MEM-01", result: "pass" },
      { test_id: "SV-MEM-03", result: "fail", detail: "scoring drift" },
    ],
  });
  const r3 = runGate(p3);
  assert(r3.status === 1, "unwaived non-pass cell → exit 1");
  assert(r3.stderr.includes("SV-MEM-03"), "stderr cites the offending test_id");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
process.exit(0);
