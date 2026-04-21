#!/usr/bin/env node
/**
 * Memory MCP Mock — HTTP server entry point.
 *
 *   PORT              default 8001
 *   HOST              default 127.0.0.1 (loopback only; mock is test tooling)
 *   SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS
 *   SOA_MEMORY_MCP_MOCK_RETURN_ERROR
 *   SOA_MEMORY_MCP_MOCK_SEED
 */

import { MemoryMcpMock, parseMockEnv, buildMockServer } from "../index.js";

async function main() {
  const options = parseMockEnv(process.env);
  const mock = new MemoryMcpMock(options);
  const app = await buildMockServer({ mock });
  const port = Number.parseInt(process.env["PORT"] ?? "8001", 10);
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(
      `[memory-mcp-mock] WARNING: binding to non-loopback host "${host}". ` +
        `This mock carries controllable error/timeout hooks and MUST NOT be reachable by untrusted principals.`
    );
  }
  await app.listen({ host, port });
  console.log(`[memory-mcp-mock] listening on http://${host}:${port}`);
  if (options.seedPath) {
    console.log(`[memory-mcp-mock] corpus seed loaded from ${options.seedPath}`);
  }
  if (options.timeoutAfterNCalls !== undefined) {
    console.log(
      `[memory-mcp-mock] TIMEOUT_AFTER_N_CALLS=${options.timeoutAfterNCalls} (call ${options.timeoutAfterNCalls + 1} hangs)`
    );
  }
  if (options.errorForTool) {
    console.log(`[memory-mcp-mock] RETURN_ERROR injection active for "${options.errorForTool}"`);
  }
  console.log(`  POST http://${host}:${port}/search_memories`);
  console.log(`  POST http://${host}:${port}/write_memory`);
  console.log(`  POST http://${host}:${port}/consolidate_memories`);
  console.log(`  GET  http://${host}:${port}/health`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[memory-mcp-mock] received ${sig}, closing`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[memory-mcp-mock] FATAL:", err);
  process.exit(1);
});
