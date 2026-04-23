#!/usr/bin/env node
/**
 * M5 release-gate — consumes a backend-conformance-report.json emitted per
 * the spec-repo schema (soa-harness-specification/schemas/backend-
 * conformance-report.schema.json, L-56 / commit 28e6460) and asserts:
 *
 *   summary.all_green === true
 *   OR every cell with result !== "pass" carries a non-empty
 *   waiver_reference string.
 *
 * Exits 0 on pass, 1 on fail. Used by:
 *   - .github/workflows/memory-backends-ci.yml after each backend matrix cell
 *   - the v1.0.0-rc.2 tag commit to prove M5 exit gate met
 *
 * Usage:
 *   node scripts/release-gate.mjs <path/to/backend-conformance-report.json> [...]
 *
 * Multiple paths may be supplied (all three backends in one invocation); the
 * script checks each and exits non-zero if ANY fails.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * @typedef {{
 *   backend: string,
 *   generated_at: string,
 *   summary: { all_green: boolean, waived?: boolean },
 *   cells: Array<{
 *     test_id: string,
 *     result: "pass" | "fail" | "skip" | "error",
 *     waiver_reference?: string,
 *     detail?: string,
 *   }>,
 * }} ConformanceReport
 */

function die(msg, code = 1) {
  console.error(`[release-gate] FAIL: ${msg}`);
  process.exit(code);
}

function parseArgs() {
  const paths = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  if (paths.length === 0) {
    die("usage: node scripts/release-gate.mjs <report.json> [<report2.json> ...]");
  }
  return paths.map((p) => resolve(p));
}

/**
 * @param {ConformanceReport} report
 * @param {string} source
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function checkReport(report, source) {
  const reasons = [];

  if (!report || typeof report !== "object") {
    reasons.push(`${source}: not a JSON object`);
    return { ok: false, reasons };
  }
  if (typeof report.backend !== "string" || report.backend.length === 0) {
    reasons.push(`${source}: missing or invalid backend field`);
  }
  if (!report.summary || typeof report.summary !== "object") {
    reasons.push(`${source}: missing summary object`);
    return { ok: false, reasons };
  }
  const { summary, cells } = report;

  if (summary.all_green === true) {
    return { ok: true, reasons: [] };
  }

  if (!Array.isArray(cells)) {
    reasons.push(`${source}: all_green=false and cells is not an array — cannot validate waivers`);
    return { ok: false, reasons };
  }

  const nonPass = cells.filter((c) => c && typeof c === "object" && c.result !== "pass");
  if (nonPass.length === 0) {
    reasons.push(
      `${source}: summary.all_green=${String(summary.all_green)} but no non-pass cells — summary and cells disagree`,
    );
    return { ok: false, reasons };
  }

  const unwaived = nonPass.filter(
    (c) => typeof c.waiver_reference !== "string" || c.waiver_reference.length === 0,
  );
  if (unwaived.length > 0) {
    for (const cell of unwaived) {
      reasons.push(
        `${source}: non-pass cell ${cell.test_id ?? "<no test_id>"} result=${cell.result} lacks waiver_reference`,
      );
    }
    return { ok: false, reasons };
  }

  // All non-pass cells carry a waiver.
  return { ok: true, reasons: [] };
}

function main() {
  const paths = parseArgs();
  let allOk = true;

  for (const p of paths) {
    if (!existsSync(p)) {
      allOk = false;
      console.error(`[release-gate] missing report: ${p}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      allOk = false;
      console.error(`[release-gate] malformed JSON in ${p}: ${err.message}`);
      continue;
    }
    const { ok, reasons } = checkReport(parsed, basename(p));
    if (ok) {
      const mode = parsed.summary?.all_green ? "all-green" : "all-waived";
      console.log(`[release-gate] PASS ${basename(p)} (backend=${parsed.backend ?? "?"}) — ${mode}`);
    } else {
      allOk = false;
      for (const reason of reasons) console.error(`[release-gate] ${reason}`);
    }
  }

  if (!allOk) {
    console.error("[release-gate] one or more backends failed gate");
    process.exit(1);
  }
  console.log(`[release-gate] all ${paths.length} backend(s) pass gate`);
  process.exit(0);
}

main();
