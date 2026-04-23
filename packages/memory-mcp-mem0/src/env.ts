import { readFileSync } from "node:fs";
import type { CorpusSeedEntry, ToolName } from "./types.js";
import { TOOL_NAMES } from "./types.js";

export type LLMProvider = "ollama" | "openai";

export interface Mem0Options {
  /** LLM + embedder provider. Default `ollama`. */
  provider?: LLMProvider;
  /** Ollama base URL. Used when provider=ollama. */
  ollamaUrl?: string;
  /** Qdrant base URL. */
  qdrantUrl?: string;
  /** Qdrant collection name. Default `soa_mem0_notes`. */
  collection?: string;
  /** OpenAI API key. Required when provider=openai. */
  openaiApiKey?: string;
  /** Fault-injection: -1 = never, N ≥ 0 = timeout starting on call N+1. */
  timeoutAfterNCalls?: number;
  /** Named tool returns {error:"mock-error"} instead of success. */
  errorForTool?: ToolName | null;
  /** Pre-loaded seed corpus. */
  seedCorpus?: CorpusSeedEntry[];
  seedPath?: string;
}

/**
 * Parse `SOA_MEMORY_MCP_MEM0_*` env vars into a typed option bag.
 * Throws on malformed input.
 */
export function parseMem0Env(env: NodeJS.ProcessEnv): Mem0Options {
  const opts: Mem0Options = {};

  const provider = env["SOA_MEMORY_MCP_MEM0_PROVIDER"];
  if (typeof provider === "string" && provider.length > 0) {
    if (provider !== "ollama" && provider !== "openai") {
      throw new Error(
        `SOA_MEMORY_MCP_MEM0_PROVIDER must be "ollama" or "openai", got "${provider}"`
      );
    }
    opts.provider = provider;
  }

  const ollamaUrl = env["OLLAMA_URL"];
  if (typeof ollamaUrl === "string" && ollamaUrl.length > 0) {
    opts.ollamaUrl = ollamaUrl;
  }
  const qdrantUrl = env["QDRANT_URL"];
  if (typeof qdrantUrl === "string" && qdrantUrl.length > 0) {
    opts.qdrantUrl = qdrantUrl;
  }
  const collection = env["SOA_MEMORY_MCP_MEM0_COLLECTION"];
  if (typeof collection === "string" && collection.length > 0) {
    opts.collection = collection;
  }
  const openaiKey = env["OPENAI_API_KEY"];
  if (typeof openaiKey === "string" && openaiKey.length > 0) {
    opts.openaiApiKey = openaiKey;
  }

  const timeoutRaw = env["SOA_MEMORY_MCP_MEM0_TIMEOUT_AFTER_N_CALLS"];
  if (timeoutRaw !== undefined) {
    const n = Number.parseInt(timeoutRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `SOA_MEMORY_MCP_MEM0_TIMEOUT_AFTER_N_CALLS must be a non-negative integer, got "${timeoutRaw}"`
      );
    }
    opts.timeoutAfterNCalls = n;
  }

  const errRaw = env["SOA_MEMORY_MCP_MEM0_RETURN_ERROR"];
  if (typeof errRaw === "string" && errRaw.length > 0) {
    if (!(TOOL_NAMES as readonly string[]).includes(errRaw)) {
      throw new Error(
        `SOA_MEMORY_MCP_MEM0_RETURN_ERROR must name a tool (${TOOL_NAMES.join(" | ")}), got "${errRaw}"`
      );
    }
    opts.errorForTool = errRaw as ToolName;
  }

  const seedPath = env["SOA_MEMORY_MCP_MEM0_SEED"];
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
