import { fastify, type FastifyInstance } from "fastify";
import type { SqliteMemoryBackend } from "./sqlite-backend.js";
import type {
  AddMemoryNoteRequest,
  ConsolidateMemoriesRequest,
  DeleteMemoryNoteRequest,
  ReadMemoryNoteRequest,
  SearchMemoriesByTimeRequest,
  SearchMemoriesRequest
} from "./types.js";

/**
 * Fastify HTTP transport for the §8.1 six-tool surface.
 *
 *   POST /search_memories          — body: SearchMemoriesRequest
 *   POST /search_memories_by_time  — body: SearchMemoriesByTimeRequest
 *   POST /add_memory_note          — body: AddMemoryNoteRequest
 *   POST /read_memory_note         — body: ReadMemoryNoteRequest
 *   POST /consolidate_memories     — body: ConsolidateMemoriesRequest
 *   POST /delete_memory_note       — body: DeleteMemoryNoteRequest
 *   GET  /health                   — 200 {status:"alive"}
 *
 * When the backend's `shouldTimeout()` returns true the handler never
 * resolves — callers' client-side timeout fires. Matches the mock's
 * fault-injection contract so HR-17 probes run unchanged.
 */

export interface SqliteServerOptions {
  backend: SqliteMemoryBackend;
  /** Optional abort signal for test-time cancel of hung handlers. */
  timeoutAbortSignal?: AbortSignal;
}

export async function buildSqliteServer(opts: SqliteServerOptions): Promise<FastifyInstance> {
  const app = fastify();

  app.get("/health", async () => ({ status: "alive" }));

  app.post<{ Body: SearchMemoriesRequest }>("/search_memories", async (request, reply) => {
    if (opts.backend.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const body = request.body ?? ({ query: "" } as SearchMemoriesRequest);
    return reply.send(await opts.backend.searchMemories(body));
  });

  app.post<{ Body: SearchMemoriesByTimeRequest }>(
    "/search_memories_by_time",
    async (request, reply) => {
      if (opts.backend.shouldTimeout()) {
        await neverResolve(opts.timeoutAbortSignal);
        return reply.code(504).send({ error: "mock-timeout" });
      }
      const body = request.body ?? ({} as SearchMemoriesByTimeRequest);
      return reply.send(await opts.backend.searchMemoriesByTime(body));
    }
  );

  app.post<{ Body: AddMemoryNoteRequest }>("/add_memory_note", async (request, reply) => {
    if (opts.backend.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const body = request.body ?? ({} as AddMemoryNoteRequest);
    return reply.send(await opts.backend.addMemoryNote(body));
  });

  app.post<{ Body: ReadMemoryNoteRequest }>("/read_memory_note", async (request, reply) => {
    if (opts.backend.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const body = request.body ?? ({} as ReadMemoryNoteRequest);
    return reply.send(await opts.backend.readMemoryNote(body));
  });

  app.post<{ Body: ConsolidateMemoriesRequest }>(
    "/consolidate_memories",
    async (request, reply) => {
      if (opts.backend.shouldTimeout()) {
        await neverResolve(opts.timeoutAbortSignal);
        return reply.code(504).send({ error: "mock-timeout" });
      }
      const body = request.body ?? ({} as ConsolidateMemoriesRequest);
      return reply.send(await opts.backend.consolidateMemories(body));
    }
  );

  app.post<{ Body: DeleteMemoryNoteRequest }>("/delete_memory_note", async (request, reply) => {
    if (opts.backend.shouldTimeout()) {
      await neverResolve(opts.timeoutAbortSignal);
      return reply.code(504).send({ error: "mock-timeout" });
    }
    const body = request.body ?? ({} as DeleteMemoryNoteRequest);
    return reply.send(await opts.backend.deleteMemoryNote(body));
  });

  return app;
}

function neverResolve(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
