import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify, type FastifyInstance } from "fastify";
import {
  MemoryMcpClient,
  MemoryTimeout,
  MemoryToolError,
  MemoryDegradationTracker
} from "../src/memory/index.js";

describe("MemoryMcpClient §8.1/§8.3 HTTP client", () => {
  let mockApp: FastifyInstance;
  let endpoint: string;
  let behavior: "ok" | "timeout" | "error" = "ok";

  beforeEach(async () => {
    mockApp = fastify();
    mockApp.post("/search_memories", async (_req, reply) => {
      if (behavior === "timeout") {
        // simulate an unresponsive upstream by returning 504 (the
        // mock contract maps this to a timeout)
        return reply.code(504).send({ error: "mock-timeout" });
      }
      if (behavior === "error") return reply.send({ error: "mock-error" });
      return reply.send({
        notes: [
          {
            note_id: "mem_fixture_0001",
            summary: "fixture",
            data_class: "public",
            composite_score: 0.5
          }
        ]
      });
    });
    mockApp.post("/write_memory", async () => ({ note_id: "mem_abcdef012345" }));
    mockApp.post("/consolidate_memories", async () => ({
      consolidated_count: 0,
      pending_count: 0
    }));
    await mockApp.listen({ host: "127.0.0.1", port: 0 });
    const addr = mockApp.server.address();
    if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
    endpoint = `http://127.0.0.1:${addr.port}`;
    behavior = "ok";
  });

  afterEach(async () => {
    await mockApp.close();
  });

  it("searchMemories returns parsed notes when the mock is healthy", async () => {
    const client = new MemoryMcpClient({ endpoint });
    const res = await client.searchMemories({ query: "hello" });
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]?.note_id).toBe("mem_fixture_0001");
  });

  it("504 response throws MemoryTimeout (mock-timeout contract)", async () => {
    behavior = "timeout";
    const client = new MemoryMcpClient({ endpoint, timeoutMs: 200 });
    let caught: unknown;
    try {
      await client.searchMemories({ query: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryTimeout);
  });

  it("{error:...} response throws MemoryToolError", async () => {
    behavior = "error";
    const client = new MemoryMcpClient({ endpoint });
    let caught: unknown;
    try {
      await client.searchMemories({ query: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryToolError);
  });

  it("connection refused → MemoryTimeout (§8.3 'connection failure' branch)", async () => {
    const client = new MemoryMcpClient({
      endpoint: "http://127.0.0.1:1", // unlikely to be listening
      timeoutMs: 200
    });
    let caught: unknown;
    try {
      await client.searchMemories({ query: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryTimeout);
  });

  it("writeMemory round-trip returns the minted note_id", async () => {
    const client = new MemoryMcpClient({ endpoint });
    const res = await client.writeMemory({
      summary: "a",
      data_class: "public",
      session_id: "ses_fixturewrite000001a"
    });
    expect(res.note_id).toBe("mem_abcdef012345");
  });

  it("consolidateMemories returns the counts", async () => {
    const client = new MemoryMcpClient({ endpoint });
    const res = await client.consolidateMemories("oldest-first");
    expect(res.consolidated_count).toBe(0);
    expect(res.pending_count).toBe(0);
  });
});

describe("MemoryDegradationTracker §8.3 three-consecutive-failures", () => {
  it("starts at 0; recordFailure increments; threshold crossed at 3", () => {
    const t = new MemoryDegradationTracker();
    expect(t.isDegraded()).toBe(false);
    t.recordFailure();
    expect(t.currentCount()).toBe(1);
    t.recordFailure();
    t.recordFailure();
    expect(t.currentCount()).toBe(3);
    expect(t.isDegraded()).toBe(true);
  });

  it("recordSuccess resets the counter; a subsequent failure starts from 0", () => {
    const t = new MemoryDegradationTracker();
    t.recordFailure();
    t.recordFailure();
    t.recordSuccess();
    expect(t.currentCount()).toBe(0);
    expect(t.isDegraded()).toBe(false);
    t.recordFailure();
    expect(t.currentCount()).toBe(1);
  });

  it("custom threshold honored", () => {
    const t = new MemoryDegradationTracker(2);
    t.recordFailure();
    expect(t.isDegraded()).toBe(false);
    t.recordFailure();
    expect(t.isDegraded()).toBe(true);
  });
});
