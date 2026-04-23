#!/usr/bin/env node
/**
 * `@soa-harness/memory-mcp-mem0` HTTP server entry point.
 *
 * Env:
 *   PORT                                default 8006
 *   HOST                                default 127.0.0.1 (loopback guard)
 *   OLLAMA_URL                          default http://localhost:11434
 *   QDRANT_URL                          default http://localhost:6333
 *   SOA_MEMORY_MCP_MEM0_PROVIDER        `ollama` (default) | `openai`
 *   SOA_MEMORY_MCP_MEM0_COLLECTION      Qdrant collection (default `soa_mem0_notes`)
 *   OPENAI_API_KEY                      required when provider=openai
 *   SOA_MEMORY_MCP_MEM0_SEED            optional corpus seed
 *   SOA_MEMORY_MCP_MEM0_TIMEOUT_AFTER_N_CALLS
 *   SOA_MEMORY_MCP_MEM0_RETURN_ERROR
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mem0Backend } from "../mem0-backend.js";
import { createMem0Client } from "../mem0-client-factory.js";
import { parseMem0Env } from "../env.js";
import { buildMem0Server } from "../server.js";

async function main(): Promise<void> {
  const options = parseMem0Env(process.env);
  const provider = options.provider ?? "ollama";
  const collection = options.collection ?? "soa_mem0_notes";
  if (provider === "openai" && !options.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when SOA_MEMORY_MCP_MEM0_PROVIDER=openai");
  }

  const client = await createMem0Client({
    provider,
    collection,
    ...(options.ollamaUrl ? { ollamaUrl: options.ollamaUrl } : {}),
    ...(options.qdrantUrl ? { qdrantUrl: options.qdrantUrl } : {}),
    ...(options.openaiApiKey ? { openaiApiKey: options.openaiApiKey } : {})
  });

  const backend = new Mem0Backend({
    client,
    timeoutAfterNCalls: options.timeoutAfterNCalls ?? -1,
    errorForTool: options.errorForTool ?? null,
    ...(options.seedCorpus ? { seedCorpus: options.seedCorpus } : {})
  });

  const app = await buildMem0Server({ backend });
  const port = Number.parseInt(process.env["PORT"] ?? "8006", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(
      `[memory-mcp-mem0] WARNING: binding to non-loopback host "${host}". ` +
        `The fault-injection hooks in this package MUST NOT be reachable by untrusted principals.`
    );
  }
  await app.listen({ host, port });
  console.log(`[memory-mcp-mem0] listening on http://${host}:${port}`);
  console.log(`[memory-mcp-mem0] provider=${provider} collection=${collection}`);
  console.log(`[memory-mcp-mem0] qdrant=${options.qdrantUrl ?? "http://localhost:6333"}`);
  if (provider === "ollama") {
    console.log(`[memory-mcp-mem0] ollama=${options.ollamaUrl ?? "http://localhost:11434"}`);
  }
  if (options.seedPath) {
    console.log(`[memory-mcp-mem0] corpus seed loaded from ${options.seedPath}`);
  }
  if (options.timeoutAfterNCalls !== undefined) {
    console.log(
      `[memory-mcp-mem0] TIMEOUT_AFTER_N_CALLS=${options.timeoutAfterNCalls} (call ${options.timeoutAfterNCalls + 1} hangs)`
    );
  }
  if (options.errorForTool) {
    console.log(`[memory-mcp-mem0] RETURN_ERROR injection active for "${options.errorForTool}"`);
  }
  console.log(`  POST http://${host}:${port}/search_memories`);
  console.log(`  POST http://${host}:${port}/search_memories_by_time`);
  console.log(`  POST http://${host}:${port}/add_memory_note`);
  console.log(`  POST http://${host}:${port}/read_memory_note`);
  console.log(`  POST http://${host}:${port}/consolidate_memories`);
  console.log(`  POST http://${host}:${port}/delete_memory_note`);
  console.log(`  GET  http://${host}:${port}/health`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[memory-mcp-mem0] received ${sig}, closing`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// realpathSync guard — lets `npm install -g` work on Linux/macOS where
// /usr/bin/<name> is a symlink to the real dist file (Phase 1 sqlite
// pattern from create-soa-agent rc.2).
const here = fileURLToPath(import.meta.url);
let invoker = "";
if (process.argv[1]) {
  try {
    invoker = realpathSync(process.argv[1]);
  } catch {
    invoker = process.argv[1];
  }
}
if (here === invoker) {
  main().catch((err) => {
    console.error("[memory-mcp-mem0] FATAL:", err);
    process.exit(1);
  });
}
