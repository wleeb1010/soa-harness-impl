#!/usr/bin/env node
/**
 * `@soa-harness/memory-mcp-sqlite` HTTP server entry point.
 *
 * Env:
 *   PORT                                  default 8005
 *   HOST                                  default 127.0.0.1 (loopback guard; warn otherwise)
 *   SOA_MEMORY_MCP_SQLITE_DB              path to SQLite DB file (default ./soa-memory.sqlite)
 *   SOA_MEMORY_MCP_SQLITE_SCORER          `naive` (default) | `transformers`
 *   SOA_MEMORY_MCP_SQLITE_SEED            optional corpus-seed.json path
 *   SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS
 *   SOA_MEMORY_MCP_SQLITE_RETURN_ERROR
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteMemoryBackend } from "../sqlite-backend.js";
import { parseSqliteEnv } from "../env.js";
import { scorerFromEnv } from "../embeddings.js";
import { buildSqliteServer } from "../server.js";

async function main(): Promise<void> {
  const options = parseSqliteEnv(process.env);
  const scorer = scorerFromEnv(process.env);
  const backend = new SqliteMemoryBackend({
    dbPath: options.dbPath ?? "./soa-memory.sqlite",
    timeoutAfterNCalls: options.timeoutAfterNCalls ?? -1,
    errorForTool: options.errorForTool ?? null,
    ...(options.seedCorpus ? { seedCorpus: options.seedCorpus } : {}),
    scorer
  });

  const app = await buildSqliteServer({ backend });
  const port = Number.parseInt(process.env["PORT"] ?? "8005", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(
      `[memory-mcp-sqlite] WARNING: binding to non-loopback host "${host}". ` +
        `The fault-injection hooks in this package MUST NOT be reachable by untrusted principals.`
    );
  }
  await app.listen({ host, port });
  console.log(`[memory-mcp-sqlite] listening on http://${host}:${port}`);
  console.log(`[memory-mcp-sqlite] db=${options.dbPath ?? "./soa-memory.sqlite"}`);
  console.log(`[memory-mcp-sqlite] scorer=${process.env["SOA_MEMORY_MCP_SQLITE_SCORER"] ?? "naive"}`);
  if (options.seedPath) {
    console.log(`[memory-mcp-sqlite] corpus seed loaded from ${options.seedPath}`);
  }
  if (options.timeoutAfterNCalls !== undefined) {
    console.log(
      `[memory-mcp-sqlite] TIMEOUT_AFTER_N_CALLS=${options.timeoutAfterNCalls} (call ${options.timeoutAfterNCalls + 1} hangs)`
    );
  }
  if (options.errorForTool) {
    console.log(`[memory-mcp-sqlite] RETURN_ERROR injection active for "${options.errorForTool}"`);
  }
  console.log(`  POST http://${host}:${port}/search_memories`);
  console.log(`  POST http://${host}:${port}/search_memories_by_time`);
  console.log(`  POST http://${host}:${port}/add_memory_note`);
  console.log(`  POST http://${host}:${port}/read_memory_note`);
  console.log(`  POST http://${host}:${port}/consolidate_memories`);
  console.log(`  POST http://${host}:${port}/delete_memory_note`);
  console.log(`  GET  http://${host}:${port}/health`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[memory-mcp-sqlite] received ${sig}, closing`);
    await app.close();
    backend.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Resolve symlinks on invoker side so `npm install -g` works on Linux/mac
// where /usr/bin/<name> is symlinked to the real dist file. Matches
// create-soa-agent rc.2's pattern (commit a404c7c).
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
    console.error("[memory-mcp-sqlite] FATAL:", err);
    process.exit(1);
  });
}
