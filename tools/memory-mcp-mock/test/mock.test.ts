import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fastify } from "fastify";
import {
  MemoryMcpMock,
  parseMockEnv,
  buildMockServer,
  type SearchMemoriesResponse,
  type WriteMemoryResponse,
  type ConsolidateMemoriesResponse
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_SEED = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "soa-harness=specification",
  "test-vectors",
  "memory-mcp-mock",
  "corpus-seed.json"
);

function loadCorpus() {
  const parsed = JSON.parse(readFileSync(SPEC_SEED, "utf8")) as {
    notes: Array<{
      note_id: string;
      summary: string;
      data_class: "public" | "internal" | "confidential" | "personal";
      recency_days_ago: number;
      graph_strength: number;
    }>;
  };
  return parsed.notes;
}

describe("MemoryMcpMock — §8.1 three-tool protocol", () => {
  it("happy-path round-trip: search_memories returns top-N scored notes from the pinned seed corpus", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() });
    const res = (await mock.searchMemories({
      query: "budget projection",
      limit: 3
    })) as SearchMemoriesResponse;
    expect(res.notes).toHaveLength(3);
    // "Token budget projection uses p95-over-W algorithm." should rank top
    // for "budget projection" (both tokens match).
    const topIds = res.notes.map((n) => n.note_id);
    expect(topIds).toContain("mem_seed_0014");
    // Composite scores are deterministic + normalized.
    for (const n of res.notes) {
      expect(n.composite_score).toBeGreaterThanOrEqual(0);
      expect(n.composite_score).toBeLessThanOrEqual(1);
      expect(n.note_id).toMatch(/^mem_seed_[0-9]{4}$/);
    }
    // Increasing — wait, sorted descending so top first >= last.
    expect(res.notes[0]!.composite_score).toBeGreaterThanOrEqual(
      res.notes[res.notes.length - 1]!.composite_score
    );
  });

  it("happy-path round-trip: write_memory → consolidate_memories chain", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() });
    const writeA = (await mock.writeMemory({
      summary: "Test session note A",
      data_class: "internal",
      session_id: "ses_mocktestfixture0001"
    })) as WriteMemoryResponse;
    const writeB = (await mock.writeMemory({
      summary: "Test session note B",
      data_class: "public",
      session_id: "ses_mocktestfixture0001"
    })) as WriteMemoryResponse;
    expect(writeA.note_id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(writeB.note_id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(writeA.note_id).not.toBe(writeB.note_id);

    const consolidated = (await mock.consolidateMemories({
      consolidation_threshold: "oldest-first"
    })) as ConsolidateMemoriesResponse;
    expect(consolidated.consolidated_count).toBe(2);
    expect(consolidated.pending_count).toBe(0);

    // A second consolidate with no new writes → zero consolidated.
    const again = (await mock.consolidateMemories({})) as ConsolidateMemoriesResponse;
    expect(again.consolidated_count).toBe(0);
  });

  it("timeout-after-N behavior: shouldTimeout flips to true after N successful calls (HR-17 support)", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus(), timeoutAfterNCalls: 2 });
    expect(mock.shouldTimeout()).toBe(false); // call 1 pre-dispatch
    await mock.searchMemories({ query: "q" });
    expect(mock.shouldTimeout()).toBe(false); // call 2 pre-dispatch
    await mock.searchMemories({ query: "q" });
    expect(mock.shouldTimeout()).toBe(true); // call 3 will time out
    await mock.searchMemories({ query: "q" });
    expect(mock.shouldTimeout()).toBe(true); // still timing out
  });

  it("timeout-after-0 behavior: every call times out immediately (HR-17 choreography)", async () => {
    const mock = new MemoryMcpMock({ timeoutAfterNCalls: 0 });
    expect(mock.shouldTimeout()).toBe(true);
    expect(mock.invocationCount()).toBe(0);
  });

  it("error-injection: SOA_MEMORY_MCP_MOCK_RETURN_ERROR routes the named tool to {error:'mock-error'}", async () => {
    const mock = new MemoryMcpMock({ errorForTool: "write_memory" });
    // search_memories still works normally
    const search = await mock.searchMemories({ query: "anything" });
    expect("error" in search).toBe(false);
    // write_memory returns the mock error
    const write = await mock.writeMemory({
      summary: "x",
      data_class: "public",
      session_id: "ses_errfixture0000000001"
    });
    expect("error" in write).toBe(true);
    expect((write as { error: string }).error).toBe("mock-error");
  });

  it("parseMockEnv: valid env values; junk raises", () => {
    expect(parseMockEnv({})).toEqual({});
    expect(parseMockEnv({ SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS: "3" })).toEqual({
      timeoutAfterNCalls: 3
    });
    expect(parseMockEnv({ SOA_MEMORY_MCP_MOCK_RETURN_ERROR: "search_memories" })).toEqual({
      errorForTool: "search_memories"
    });
    expect(() =>
      parseMockEnv({ SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS: "bogus" })
    ).toThrow(/non-negative integer/);
    expect(() => parseMockEnv({ SOA_MEMORY_MCP_MOCK_RETURN_ERROR: "bad-tool" })).toThrow(
      /must name a tool/
    );
  });

  it("HTTP server: /health responds 200; /search_memories routes to the mock", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() });
    const app = await buildMockServer({ mock });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "alive" });

      const search = await app.inject({
        method: "POST",
        url: "/search_memories",
        headers: { "content-type": "application/json" },
        payload: { query: "agent card", limit: 2 }
      });
      expect(search.statusCode).toBe(200);
      const body = JSON.parse(search.body) as SearchMemoriesResponse;
      expect(body.notes).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
