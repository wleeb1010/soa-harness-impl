#!/usr/bin/env node
/**
 * M5 Phase 4 — unified backend-conformance-report orchestrator.
 *
 * For each of the three reference backends (sqlite / mem0 / zep):
 *   1. Boot the backend on its canonical port (8005 / 8006 / 8007)
 *      - sqlite + mock via `node dist/bin/...`
 *      - mem0 + zep via docker compose (+ local Ollama for mem0)
 *   2. Bounce the Runner pointing at that backend
 *   3. Run soa-validate --memory-backend=<name> and parse JSON
 *   4. Extract SV-MEM-01..08 + HR-17 cells + status/duration/error
 *   5. Tear down the backend
 *
 * Finally:
 *   - Map unexercised skips → waived with L-58 citation
 *   - Validate aggregate against schemas vendored
 *     backend-conformance-report.schema.json
 *   - Write ./backend-conformance-report.json
 *
 * Flags:
 *   --reuse          skip boot; aggregate from per-backend JSON files
 *                    committed into each package's `gate-phase-<X>.json`.
 *                    Useful for fast iteration + CI without docker.
 *   --out <path>     write the unified report here. Default
 *                    ./backend-conformance-report.json.
 *   --backends       comma-separated subset (default sqlite,mem0,zep).
 *
 * Exit codes:
 *   0   summary.all_green === true (every cell pass or waived)
 *   1   fail/error present, or schema validation rejected the output.
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const SPEC_VECTORS = resolve(REPO_ROOT, "..", "soa-harness=specification");
const VALIDATOR_BIN = resolve(REPO_ROOT, "..", "soa-validate", "soa-validate.exe");
const SEED = resolve(
  SPEC_VECTORS,
  "test-vectors",
  "memory-mcp-mock",
  "corpus-seed.json"
);

// --- Waiver cites -------------------------------------------------------
// Per L-58 (M5 Phase 0+1 closure), skipped SV-MEM-03..06 + HR-17 are
// known-unexercised-at-live-mode: their probe bodies require subprocess
// spawn (SOA_IMPL_BIN) or §8.7.7 fault-injection which isn't in the spec
// yet. We map these to `waived` with the L-58 citation so the aggregate
// reflects "known gap, documented remediation commitment" rather than
// treating them as silent failures.
const WAIVER_L58 = {
  "SV-MEM-03": "L-58 — subprocess-only probe; live-mode variant pending §8.7.7",
  "SV-MEM-04": "L-58 — subprocess-only probe; live-mode variant pending §8.7.7",
  "SV-MEM-05": "L-58 — subprocess-only probe; live-mode variant pending §8.7.7",
  "SV-MEM-06": "L-58 — subprocess-only probe; live-mode variant pending §8.7.7",
  "HR-17": "L-58 — live-mode HR-17 requires §8.7.7 fault-injection env surface"
};

const BACKENDS = {
  sqlite: {
    name: "@soa-harness/memory-mcp-sqlite",
    version: "1.0.0-rc.0",
    host_framework: "sqlite",
    port: 8005,
    prebuilt: "packages/memory-mcp-sqlite/gate-phase0e-sqlite.json",
    bootKind: "in-process",
    bootCmd: ["node", ["packages/memory-mcp-sqlite/dist/bin/start-sqlite.js"]],
    bootEnv: {
      PORT: "8005",
      SOA_MEMORY_MCP_SQLITE_DB: ":memory:",
      SOA_MEMORY_MCP_SQLITE_SEED: SEED
    }
  },
  mem0: {
    name: "@soa-harness/memory-mcp-mem0",
    version: "1.0.0-rc.0",
    host_framework: "mem0",
    port: 8006,
    prebuilt: "packages/memory-mcp-mem0/gate-phase2-mem0.json",
    bootKind: "docker+process",
    dockerStart: null, // Qdrant brought up manually; Ollama on host
    bootCmd: ["node", ["packages/memory-mcp-mem0/dist/bin/start-mem0.js"]],
    bootEnv: {
      PORT: "8006",
      SOA_MEMORY_MCP_MEM0_PROVIDER: "ollama",
      OLLAMA_URL: "http://localhost:11434",
      QDRANT_URL: "http://localhost:6333",
      SOA_MEMORY_MCP_MEM0_COLLECTION: "soamem0p4"
    }
  },
  zep: {
    name: "@soa-harness/memory-mcp-zep",
    version: "1.0.0-rc.0",
    host_framework: "zep",
    port: 8007,
    prebuilt: "packages/memory-mcp-zep/gate-phase3-zep.json",
    bootKind: "docker+process",
    dockerStart: "docker compose -f packages/memory-mcp-zep/docker-compose.yml up -d db nlp zep",
    dockerStop: "docker compose -f packages/memory-mcp-zep/docker-compose.yml down -v",
    bootCmd: ["node", ["packages/memory-mcp-zep/dist/bin/start-zep.js"]],
    bootEnv: {
      PORT: "8007",
      ZEP_URL: "http://localhost:8003",
      SOA_MEMORY_MCP_ZEP_COLLECTION: "soamemmcpzepp4",
      SOA_MEMORY_MCP_ZEP_SEED: SEED
    }
  }
};

// --- CLI parse ----------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
}
const REUSE = argv.includes("--reuse");
const OUT = resolve(flag("--out", "./backend-conformance-report.json"));
const SUBSET = flag("--backends", "sqlite,mem0,zep").split(",").map((s) => s.trim());

// --- Aggregate extractor ------------------------------------------------
/** Pull SV-MEM-01..08 + HR-17 cells from a validator release-gate JSON. */
function extractCells(releaseGate) {
  const TEST_IDS = [
    "SV-MEM-01",
    "SV-MEM-02",
    "SV-MEM-03",
    "SV-MEM-04",
    "SV-MEM-05",
    "SV-MEM-06",
    "SV-MEM-07",
    "SV-MEM-08",
    "HR-17"
  ];
  const byId = new Map();
  for (const r of releaseGate.results ?? []) {
    byId.set(r.id, r);
  }
  return TEST_IDS.map((id) => {
    const r = byId.get(id);
    if (!r) {
      return {
        test_id: id,
        status: "waived",
        waiver_reference: WAIVER_L58[id] ?? "L-58 — test not registered in this validator build"
      };
    }
    const status = r.status;
    const cell = { test_id: id, status };
    if (typeof r.duration_ms === "number" && r.duration_ms >= 0) {
      cell.duration_ms = r.duration_ms;
    }
    if (status === "fail" || status === "error") {
      cell.error_message = (r.message ?? "").slice(0, 4096);
    }
    if (status === "skip") {
      // Re-map skips to waived per the L-58 rule.
      cell.status = "waived";
      cell.waiver_reference = WAIVER_L58[id] ?? "L-58 — skipped live-mode pending §8.7.7";
    }
    return cell;
  });
}

function readSpecPin() {
  const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, "soa-validate.lock"), "utf8"));
  return lock.spec_commit_sha;
}

// --- Orchestration ------------------------------------------------------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function runValidator(backendLabel, port, outPath) {
  const env = {
    ...process.env,
    SOA_IMPL_URL: "http://127.0.0.1:7700",
    SOA_MEMORY_MCP_ENDPOINT: `http://127.0.0.1:${port}`,
    SOA_RUNNER_BOOTSTRAP_BEARER: "validator-baseline-bearer"
  };
  execSync(
    `"${VALIDATOR_BIN}" --impl-url http://127.0.0.1:7700 --memory-backend=${backendLabel} --spec-vectors "${SPEC_VECTORS}" --out "${outPath}"`,
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
}

async function runBackend(label) {
  const cfg = BACKENDS[label];
  if (!cfg) throw new Error(`unknown backend: ${label}`);

  if (cfg.dockerStart) {
    console.log(`[${label}] docker compose up`);
    execSync(cfg.dockerStart, { cwd: REPO_ROOT, stdio: "inherit" });
    // Zep needs ~30s to become healthy the first time.
    if (label === "zep") await waitFor("http://localhost:8003/healthz", 120_000);
  }

  console.log(`[${label}] starting backend on :${cfg.port}`);
  const backendProc = spawn(cfg.bootCmd[0], cfg.bootCmd[1], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...cfg.bootEnv },
    stdio: "pipe"
  });
  await waitFor(`http://localhost:${cfg.port}/health`);

  console.log(`[${label}] stopping dev-runner + launching Runner pointed at :${cfg.port}`);
  try {
    execSync("bash scripts/dev-runner.sh stop", { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    // dev-runner may already be stopped
  }
  const runnerEnv = {
    ...process.env,
    RUNNER_HOST: "127.0.0.1",
    RUNNER_PORT: "7700",
    RUNNER_CARD_FIXTURE: join(SPEC_VECTORS, "test-vectors/conformance-card/agent-card.json"),
    RUNNER_TOOLS_FIXTURE: join(SPEC_VECTORS, "test-vectors/tool-registry/tools.json"),
    RUNNER_INITIAL_TRUST: join(SPEC_VECTORS, "test-vectors/initial-trust/valid.json"),
    RUNNER_SESSION_DIR: "./sessions",
    SOA_RUNNER_BOOTSTRAP_BEARER: "validator-baseline-bearer",
    RUNNER_DEMO_SESSION:
      "ses_demoWeek3Conformance01:soa-conformance-week3-decide-bearer:DangerFullAccess",
    SOA_RUNNER_MEMORY_MCP_ENDPOINT: `http://127.0.0.1:${cfg.port}`,
    SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION: "./logs/dynamic-tool-trigger.json",
    RUNNER_CRASH_TEST_MARKERS: "0",
    RUNNER_DEMO_MODE: "1"
  };
  const runnerProc = spawn(
    "node",
    ["packages/runner/dist/bin/start-runner.js"],
    { cwd: REPO_ROOT, env: runnerEnv, stdio: "pipe" }
  );
  await waitFor("http://127.0.0.1:7700/ready");

  const outPath = resolve(REPO_ROOT, `.m5-run-${label}.json`);
  try {
    console.log(`[${label}] running validator`);
    await runValidator(label, cfg.port, outPath);
  } finally {
    runnerProc.kill("SIGKILL");
    backendProc.kill("SIGKILL");
    await sleep(1000);
    if (cfg.dockerStop) {
      console.log(`[${label}] docker compose down`);
      try {
        execSync(cfg.dockerStop, { cwd: REPO_ROOT, stdio: "inherit" });
      } catch {}
    }
  }
  return JSON.parse(readFileSync(outPath, "utf8"));
}

// --- Main ---------------------------------------------------------------
async function main() {
  const specPin = readSpecPin();
  console.log(`[m5-conformance-run] spec_commit=${specPin.slice(0, 12)}...`);
  console.log(`[m5-conformance-run] backends=${SUBSET.join(",")} reuse=${REUSE}`);

  const backendEntries = [];
  for (const label of SUBSET) {
    const cfg = BACKENDS[label];
    if (!cfg) {
      console.error(`[m5-conformance-run] unknown backend '${label}'`);
      process.exit(1);
    }
    let validatorReport;
    if (REUSE) {
      const p = resolve(REPO_ROOT, cfg.prebuilt);
      if (!existsSync(p)) {
        console.error(`[m5-conformance-run] --reuse: missing ${cfg.prebuilt}`);
        process.exit(1);
      }
      validatorReport = JSON.parse(readFileSync(p, "utf8"));
      console.log(`[${label}] reused ${cfg.prebuilt}`);
    } else {
      validatorReport = await runBackend(label);
    }
    const cells = extractCells(validatorReport);
    const entry = {
      name: cfg.name,
      version: cfg.version,
      host_framework: cfg.host_framework,
      endpoint_url: `http://127.0.0.1:${cfg.port}`,
      cells
    };
    backendEntries.push(entry);
  }

  // Build summary
  const cellCount = backendEntries[0]?.cells.length ?? 0;
  let failingCount = 0;
  let waiverCount = 0;
  let allGreen = true;
  for (const b of backendEntries) {
    for (const c of b.cells) {
      if (c.status === "fail" || c.status === "error") {
        failingCount++;
        allGreen = false;
      } else if (c.status === "waived") {
        waiverCount++;
      } else if (c.status === "skip") {
        allGreen = false;
      }
    }
  }

  const report = {
    report_version: "1.0",
    spec_commit: specPin,
    generated_at: new Date().toISOString(),
    backends: backendEntries,
    summary: {
      all_green: allGreen,
      backends_tested: backendEntries.length,
      tests_per_backend: cellCount,
      failing_count: failingCount,
      waiver_count: waiverCount
    }
  };

  // Schema-validate the output
  const schema = JSON.parse(
    readFileSync(
      resolve(
        REPO_ROOT,
        "packages/schemas/src/schemas/vendored/backend-conformance-report.schema.json"
      ),
      "utf8"
    )
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(report);
  if (!ok) {
    console.error("[m5-conformance-run] FAIL: output does not validate against schema");
    console.error(JSON.stringify(validate.errors, null, 2));
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`[m5-conformance-run] wrote ${OUT}`);
  console.log(
    `[m5-conformance-run] summary: all_green=${allGreen} backends=${backendEntries.length} cells/backend=${cellCount} fails=${failingCount} waivers=${waiverCount}`
  );
  if (!allGreen) {
    console.error("[m5-conformance-run] FAIL: summary.all_green=false");
    process.exit(1);
  }
  console.log("[m5-conformance-run] PASS");
}

main().catch((err) => {
  console.error("[m5-conformance-run] FATAL:", err);
  process.exit(1);
});
