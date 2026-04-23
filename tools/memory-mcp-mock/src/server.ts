import { fastify, type FastifyInstance } from "fastify";
import { MemoryMcpMock } from "./mock.js";
import type {
  SearchMemoriesRequest,
  SearchMemoriesByTimeRequest,
  AddMemoryNoteRequest,
  ReadMemoryNoteRequest,
  ConsolidateMemoriesRequest,
  DeleteMemoryNoteRequest
} from "./mock.js";

/**
 * HTTP transport for the Memory MCP mock. Endpoints (§8.1 — 6 tools):
 *   POST /search_memories          — body: SearchMemoriesRequest
 *   POST /search_memories_by_time  — body: SearchMemoriesByTimeRequest
 *   POST /add_memory_note          — body: AddMemoryNoteRequest
 *   POST /read_memory_note         — body: ReadMemoryNoteRequest
 *   POST /consolidate_memories     — body: ConsolidateMemoriesRequest
 *   POST /delete_memory_note       — body: DeleteMemoryNoteRequest
 *   GET  /health                   — 200 {status:"alive"}
 *
 * Timeout injection: when `shouldTimeout()` returns true, the handler never
 * resolves its reply. The caller's 5s client-side timeout trips. The mock
 * doesn't force-close the socket — it simulates an unresponsive sink.
 */

export interface MockServerOptions {
  mock: MemoryMcpMock;
  /** Override for tests: signal-like promise that resolves to cancel timeouts. */
  timeoutAbortSignal?: AbortSignal;
}

export async function buildMockServer(opts: MockServerOptions): Promise<FastifyInstance> {
  const app = fastify();

  app.get("/health", async () => ({ status: "alive" }));

  app.post<{ Body: SearchMemoriesRequest }>("/search_memories", async (request, reply) => {
    if (opts.mock.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const result = await opts.mock.searchMemories(request.body ?? ({} as SearchMemoriesRequest));
    return reply.send(result);
  });

  app.post<{ Body: AddMemoryNoteRequest }>("/add_memory_note", async (request, reply) => {
    if (opts.mock.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const result = await opts.mock.addMemoryNote(request.body ?? ({} as AddMemoryNoteRequest));
    return reply.send(result);
  });

  app.post<{ Body: SearchMemoriesByTimeRequest }>(
    "/search_memories_by_time",
    async (request, reply) => {
      if (opts.mock.shouldTimeout()) {
        await neverResolve(opts.timeoutAbortSignal);
        return reply.code(504).send({ error: "mock-timeout" });
      }
      const result = await opts.mock.searchMemoriesByTime(
        request.body ?? ({} as SearchMemoriesByTimeRequest),
      );
      return reply.send(result);
    },
  );

  app.post<{ Body: ReadMemoryNoteRequest }>("/read_memory_note", async (request, reply) => {
    if (opts.mock.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const result = await opts.mock.readMemoryNote(
      request.body ?? ({} as ReadMemoryNoteRequest),
    );
    return reply.send(result);
  });

  app.post<{ Body: ConsolidateMemoriesRequest }>(
    "/consolidate_memories",
    async (request, reply) => {
      if (opts.mock.shouldTimeout()) {
        await neverResolve(opts.timeoutAbortSignal);
        return reply.code(504).send({ error: "mock-timeout" });
      }
      const result = await opts.mock.consolidateMemories(
        request.body ?? ({} as ConsolidateMemoriesRequest)
      );
      return reply.send(result);
    }
  );

  app.post<{ Body: DeleteMemoryNoteRequest }>("/delete_memory_note", async (request, reply) => {
    if (opts.mock.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const result = await opts.mock.deleteMemoryNote(
      request.body ?? ({} as DeleteMemoryNoteRequest)
    );
    return reply.send(result);
  });

  return app;
}

/**
 * Resolves when the abort signal fires, or never otherwise. Used to
 * simulate a stuck upstream: the Runner's 5s client-side timeout MUST
 * trip. In tests, signal fires to unblock the pending request and let
 * the server shut down cleanly.
 */
function neverResolve(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
