import { readFileSync } from "node:fs";
import type { CorpusSeedEntry, ToolName } from "./types.js";
import { TOOL_NAMES } from "./types.js";

export interface SqliteOptions {
  /** DB file path. `:memory:` for tests. */
  dbPath?: string;
  /** Pre-parsed fault-injection: -1 = never, N ≥ 0 = timeout starting on call N+1. */
  timeoutAfterNCalls?: number;
  /** Named tool returns {error:"mock-error"} instead of success. */
  errorForTool?: ToolName | null;
  /** Pre-loaded seed corpus (tests) or loaded from env path. */
  seedCorpus?: CorpusSeedEntry[];
  /** Raw seed path (for operator visibility). */
  seedPath?: string;
}

/**
 * Parse `SOA_MEMORY_MCP_SQLITE_*` env vars into a typed option bag.
 * Throws on malformed input (integer parse, unknown tool name, missing
 * seed file) so boot fails fast with a cited cause.
 */
export function parseSqliteEnv(env: NodeJS.ProcessEnv): SqliteOptions {
  const opts: SqliteOptions = {};
  const dbPath = env["SOA_MEMORY_MCP_SQLITE_DB"];
  if (typeof dbPath === "string" && dbPath.length > 0) {
    opts.dbPath = dbPath;
  }

  const timeoutRaw = env["SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS"];
  if (timeoutRaw !== undefined) {
    const n = Number.parseInt(timeoutRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS must be a non-negative integer, got "${timeoutRaw}"`
      );
    }
    opts.timeoutAfterNCalls = n;
  }

  const errRaw = env["SOA_MEMORY_MCP_SQLITE_RETURN_ERROR"];
  if (typeof errRaw === "string" && errRaw.length > 0) {
    if (!(TOOL_NAMES as readonly string[]).includes(errRaw)) {
      throw new Error(
        `SOA_MEMORY_MCP_SQLITE_RETURN_ERROR must name a tool (${TOOL_NAMES.join(" | ")}), got "${errRaw}"`
      );
    }
    opts.errorForTool = errRaw as ToolName;
  }

  const seedPath = env["SOA_MEMORY_MCP_SQLITE_SEED"];
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
