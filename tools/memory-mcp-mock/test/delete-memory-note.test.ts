import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MemoryMcpMock,
  buildMockServer,
  type DeleteMemoryNoteResponse,
  type SearchMemoriesResponse
} from "../src/index.js";

// Finding Y / SV-MEM-07 — delete_memory_note tool per §8.1 line 566.

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(
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
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
    notes: { note_id: string; summary: string; data_class: string; recency_days_ago: number; graph_strength: number }[];
  };
  return parsed.notes as unknown as ReturnType<MemoryMcpMock["corpusForTest"]>;
}

// Make a private-ish accessor for tests — readonly.
declare module "../src/mock.js" {
  interface MemoryMcpMock {
    corpusForTest(): unknown;
  }
}

describe("delete_memory_note — §8.1 idempotent tombstone contract", () => {
  it("first call: returns deleted=true + fresh tombstone_id + deleted_at", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() as never });
    const firstCorpusId = (loadCorpus() as unknown as { note_id: string }[])[0]!.note_id;
    const res = (await mock.deleteMemoryNote({
      id: firstCorpusId,
      reason: "test-deletion"
    })) as DeleteMemoryNoteResponse;
    expect(res.deleted).toBe(true);
    expect(res.tombstone_id).toMatch(/^tomb_[0-9a-f]{12}$/);
    expect(res.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("idempotency: repeat delete with same id returns identical tombstone_id + deleted_at", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() as never });
    const id = (loadCorpus() as unknown as { note_id: string }[])[0]!.note_id;
    const first = (await mock.deleteMemoryNote({ id, reason: "first" })) as DeleteMemoryNoteResponse;
    const second = (await mock.deleteMemoryNote({ id, reason: "second" })) as DeleteMemoryNoteResponse;
    const third = (await mock.deleteMemoryNote({ id })) as DeleteMemoryNoteResponse;
    expect(second.tombstone_id).toBe(first.tombstone_id);
    expect(second.deleted_at).toBe(first.deleted_at);
    expect(third.tombstone_id).toBe(first.tombstone_id);
    expect(third.deleted_at).toBe(first.deleted_at);
    // Tombstone record retained.
    const ts = mock.tombstoneFor(id)!;
    expect(ts.id).toBe(id);
    expect(ts.reason).toBe("first"); // only the first reason is recorded
  });

  it("search_memories must NOT return tombstoned ids", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() as never });
    const ids = (loadCorpus() as unknown as { note_id: string }[]).map((n) => n.note_id);
    // Delete the first 3 corpus ids.
    for (const id of ids.slice(0, 3)) {
      await mock.deleteMemoryNote({ id, reason: "cleanup" });
    }
    const search = (await mock.searchMemories({
      query: "agent card",
      limit: 50
    })) as SearchMemoriesResponse;
    for (const hit of search.hits) {
      expect(ids.slice(0, 3)).not.toContain(hit.note_id);
    }
  });

  it("unknown id: returns error sentinel (MemoryNotFound)", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() as never });
    const res = (await mock.deleteMemoryNote({
      id: "mem_does_not_exist",
      reason: "x"
    })) as { error: string };
    expect(res.error).toBe("mock-error");
  });

  it("error injection: SOA_MEMORY_MCP_MOCK_RETURN_ERROR=delete_memory_note returns mock-error", async () => {
    const mock = new MemoryMcpMock({
      seedCorpus: loadCorpus() as never,
      errorForTool: "delete_memory_note"
    });
    const id = (loadCorpus() as unknown as { note_id: string }[])[0]!.note_id;
    const res = (await mock.deleteMemoryNote({ id })) as { error: string };
    expect(res.error).toBe("mock-error");
  });

  it("HTTP transport: POST /delete_memory_note routes to the mock", async () => {
    const mock = new MemoryMcpMock({ seedCorpus: loadCorpus() as never });
    const app = await buildMockServer({ mock });
    const id = (loadCorpus() as unknown as { note_id: string }[])[0]!.note_id;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/delete_memory_note",
        headers: { "content-type": "application/json" },
        payload: { id, reason: "http-test" }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as DeleteMemoryNoteResponse;
      expect(body.deleted).toBe(true);
      expect(body.tombstone_id).toMatch(/^tomb_[0-9a-f]{12}$/);

      // Idempotent HTTP: second call returns same record.
      const repeat = await app.inject({
        method: "POST",
        url: "/delete_memory_note",
        headers: { "content-type": "application/json" },
        payload: { id, reason: "http-test-again" }
      });
      const body2 = JSON.parse(repeat.body) as DeleteMemoryNoteResponse;
      expect(body2.tombstone_id).toBe(body.tombstone_id);
      expect(body2.deleted_at).toBe(body.deleted_at);
    } finally {
      await app.close();
    }
  });
});
