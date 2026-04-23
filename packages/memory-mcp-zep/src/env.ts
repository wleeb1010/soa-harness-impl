import { readFileSync } from "node:fs";
import type { CorpusSeedEntry, ToolName } from "./types.js";
import { TOOL_NAMES } from "./types.js";

export interface ZepOptions {
  /** Zep server URL. Default http://localhost:8003. */
  zepUrl?: string;
  /** Collection name. Must be alphanum (Zep rejects underscores). */
  collection?: string;
  /** Fault-injection: -1 = never, N ≥ 0 = timeout starting on call N+1. */
  timeoutAfterNCalls?: number;
  /** Named tool returns {error:"mock-error"} instead of success. */
  errorForTool?: ToolName | null;
  seedCorpus?: CorpusSeedEntry[];
  seedPath?: string;
}

/**
 * Parse `SOA_MEMORY_MCP_ZEP_*` env vars into a typed option bag.
 * Throws on malformed input.
 */
export function parseZepEnv(env: NodeJS.ProcessEnv): ZepOptions {
  const opts: ZepOptions = {};

  const zepUrl = env["ZEP_URL"];
  if (typeof zepUrl === "string" && zepUrl.length > 0) {
    opts.zepUrl = zepUrl;
  }
  const collection = env["SOA_MEMORY_MCP_ZEP_COLLECTION"];
  if (typeof collection === "string" && collection.length > 0) {
    if (!/^[a-zA-Z0-9]+$/.test(collection)) {
      throw new Error(
        `SOA_MEMORY_MCP_ZEP_COLLECTION must be alphanum-only (Zep rejects underscores), got "${collection}"`
      );
    }
    opts.collection = collection;
  }

  const timeoutRaw = env["SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS"];
  if (timeoutRaw !== undefined) {
    const n = Number.parseInt(timeoutRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS must be a non-negative integer, got "${timeoutRaw}"`
      );
    }
    opts.timeoutAfterNCalls = n;
  }

  const errRaw = env["SOA_MEMORY_MCP_ZEP_RETURN_ERROR"];
  if (typeof errRaw === "string" && errRaw.length > 0) {
    if (!(TOOL_NAMES as readonly string[]).includes(errRaw)) {
      throw new Error(
        `SOA_MEMORY_MCP_ZEP_RETURN_ERROR must name a tool (${TOOL_NAMES.join(" | ")}), got "${errRaw}"`
      );
    }
    opts.errorForTool = errRaw as ToolName;
  }

  const seedPath = env["SOA_MEMORY_MCP_ZEP_SEED"];
  if (typeof seedPath === "string" && seedPath.length > 0) {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as {
      notes?: CorpusSeedEntry[];
    };
    if (!Array.isArray(parsed.notes)) {
      throw new Error(`${seedPath}: missing "notes" array`);
    }
    opts.seedCorpus = parsed.notes;
    opts.seedPath = seedPath;
  }

  return opts;
}
