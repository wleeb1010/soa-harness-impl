#!/usr/bin/env node
/**
 * `@soa-harness/memory-mcp-zep` HTTP server entry point.
 *
 * Env:
 *   PORT                                default 8007
 *   HOST                                default 127.0.0.1 (loopback guard)
 *   ZEP_URL                             default http://localhost:8003
 *   SOA_MEMORY_MCP_ZEP_COLLECTION       alphanum collection name (default `soamemmcpzep`)
 *   SOA_MEMORY_MCP_ZEP_SEED             optional corpus seed
 *   SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS
 *   SOA_MEMORY_MCP_ZEP_RETURN_ERROR
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ZepBackend } from "../zep-backend.js";
import { createZepCollection } from "../zep-client-factory.js";
import { parseZepEnv } from "../env.js";
import { buildZepServer } from "../server.js";

async function main(): Promise<void> {
  const options = parseZepEnv(process.env);
  const zepUrl = options.zepUrl ?? "http://localhost:8003";
  const collection = options.collection ?? "soamemmcpzep";

  const zepColl = await createZepCollection({ zepUrl, collection });
  const backend = new ZepBackend({
    collection: zepColl,
    timeoutAfterNCalls: options.timeoutAfterNCalls ?? -1,
    errorForTool: options.errorForTool ?? null,
    ...(options.seedCorpus ? { seedCorpus: options.seedCorpus } : {})
  });

  const app = await buildZepServer({ backend });
  const port = Number.parseInt(process.env["PORT"] ?? "8007", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(
      `[memory-mcp-zep] WARNING: binding to non-loopback host "${host}". ` +
        `The fault-injection hooks in this package MUST NOT be reachable by untrusted principals.`
    );
  }
  await app.listen({ host, port });
  console.log(`[memory-mcp-zep] listening on http://${host}:${port}`);
  console.log(`[memory-mcp-zep] zep=${zepUrl} collection=${collection}`);
  if (options.seedPath) {
    console.log(`[memory-mcp-zep] corpus seed loaded from ${options.seedPath}`);
  }
  if (options.timeoutAfterNCalls !== undefined) {
    console.log(
      `[memory-mcp-zep] TIMEOUT_AFTER_N_CALLS=${options.timeoutAfterNCalls} (call ${options.timeoutAfterNCalls + 1} hangs)`
    );
  }
  if (options.errorForTool) {
    console.log(`[memory-mcp-zep] RETURN_ERROR injection active for "${options.errorForTool}"`);
  }
  console.log(`  POST http://${host}:${port}/search_memories`);
  console.log(`  POST http://${host}:${port}/search_memories_by_time`);
  console.log(`  POST http://${host}:${port}/add_memory_note`);
  console.log(`  POST http://${host}:${port}/read_memory_note`);
  console.log(`  POST http://${host}:${port}/consolidate_memories`);
  console.log(`  POST http://${host}:${port}/delete_memory_note`);
  console.log(`  GET  http://${host}:${port}/health`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[memory-mcp-zep] received ${sig}, closing`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

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
    console.error("[memory-mcp-zep] FATAL:", err);
    process.exit(1);
  });
}
