import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqliteMemoryBackend,
  parseSqliteEnv,
  type AddMemoryNoteResponse,
  type ConsolidateMemoriesResponse,
  type CorpusSeedEntry,
  type DeleteMemoryNoteResponse,
  type MemoryNotFoundResponse,
  type ReadMemoryNoteResponse,
  type SearchMemoriesByTimeResponse,
  type SearchMemoriesResponse
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

function loadCorpus(): CorpusSeedEntry[] {
  const parsed = JSON.parse(readFileSync(SPEC_SEED, "utf8")) as { notes: CorpusSeedEntry[] };
  return parsed.notes;
}

function freshBackend(opts: Partial<ConstructorParameters<typeof SqliteMemoryBackend>[0]> = {}) {
  return new SqliteMemoryBackend({ dbPath: ":memory:", ...opts });
}

describe("SqliteMemoryBackend — §8.1 six-tool protocol", () => {
  let backend: SqliteMemoryBackend;

  beforeEach(() => {
    backend = freshBackend({ seedCorpus: loadCorpus() });
  });

  it("search_memories returns top-N scored hits from the pinned seed corpus", async () => {
    const res = (await backend.searchMemories({
      query: "budget projection",
      limit: 3
    })) as SearchMemoriesResponse;
    expect(res.hits).toHaveLength(3);
    const topIds = res.hits.map((h) => h.note_id);
    // "Token budget projection uses p95-over-W algorithm." should rank top.
    expect(topIds).toContain("mem_seed_0014");
    for (const h of res.hits) {
      expect(h.composite_score).toBeGreaterThanOrEqual(0);
      expect(h.composite_score).toBeLessThanOrEqual(1);
      expect(h.note_id).toMatch(/^mem_seed_[0-9]{4}$/);
    }
    // Descending.
    expect(res.hits[0]!.composite_score).toBeGreaterThanOrEqual(
      res.hits[res.hits.length - 1]!.composite_score
    );
  });

  it("add_memory_note is idempotent iff note_id is pre-specified (§8.1 Phase 0a)", async () => {
    const first = (await backend.addMemoryNote({
      summary: "pinned note",
      data_class: "internal",
      session_id: "ses_sqlite_idem_0001",
      note_id: "mem_fixed_pin_01"
    })) as AddMemoryNoteResponse;
    const second = (await backend.addMemoryNote({
      summary: "pinned note again",
      data_class: "internal",
      session_id: "ses_sqlite_idem_0001",
      note_id: "mem_fixed_pin_01"
    })) as AddMemoryNoteResponse;
    expect(first.note_id).toBe("mem_fixed_pin_01");
    expect(second.note_id).toBe("mem_fixed_pin_01");
    // L-58 §8.1 errata — idempotent repeat returns the *original* created_at.
    expect(second.created_at).toBe(first.created_at);
    expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const a = (await backend.addMemoryNote({
      summary: "mint a",
      data_class: "public",
      session_id: "ses_sqlite_mint000001"
    })) as AddMemoryNoteResponse;
    const b = (await backend.addMemoryNote({
      summary: "mint b",
      data_class: "public",
      session_id: "ses_sqlite_mint000001"
    })) as AddMemoryNoteResponse;
    expect(a.note_id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(b.note_id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(a.note_id).not.toBe(b.note_id);
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("add_memory_note persists tags + importance when provided (L-58 §8.1 errata)", async () => {
    const b = freshBackend();
    const res = (await b.addMemoryNote({
      summary: "tagged note",
      data_class: "internal",
      session_id: "ses_sqlite_tags000001",
      note_id: "mem_tagged00001",
      tags: ["alpha", "beta"],
      importance: 0.8
    })) as AddMemoryNoteResponse;
    expect(res.note_id).toBe("mem_tagged00001");
    const read = (await b.readMemoryNote({ id: "mem_tagged00001" })) as ReadMemoryNoteResponse;
    expect(read.tags.sort()).toEqual(["alpha", "beta"]);
    expect(read.importance).toBe(0.8);
  });

  it("search_memories_by_time returns hits inside the RFC 3339 window", async () => {
    const res = (await backend.searchMemoriesByTime({
      start: "2025-01-01T00:00:00Z",
      end: "2026-01-02T00:00:00Z"
    })) as SearchMemoriesByTimeResponse;
    expect(Array.isArray(res.hits)).toBe(true);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(false);
    for (let i = 1; i < res.hits.length; i++) {
      expect(res.hits[i]!.created_at.localeCompare(res.hits[i - 1]!.created_at)).toBeGreaterThanOrEqual(0);
    }
  });

  it("search_memories_by_time with limit truncates + flags truncated=true", async () => {
    const res = (await backend.searchMemoriesByTime({
      start: "2025-01-01T00:00:00Z",
      end: "2026-01-02T00:00:00Z",
      limit: 2
    })) as SearchMemoriesByTimeResponse;
    expect(res.hits).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it("read_memory_note returns full shape for a corpus-sourced id", async () => {
    const anyId = loadCorpus()[0]!.note_id;
    const res = (await backend.readMemoryNote({ id: anyId })) as ReadMemoryNoteResponse;
    expect(res.id).toBe(anyId);
    expect(typeof res.note).toBe("string");
    expect(Array.isArray(res.tags)).toBe(true);
    expect(typeof res.importance).toBe("number");
    expect(typeof res.created_at).toBe("string");
    expect(Array.isArray(res.graph_edges)).toBe(true);
  });

  it("read_memory_note: unknown id → MemoryNotFound", async () => {
    const res = await backend.readMemoryNote({ id: "mem_does_not_exist" });
    expect("error" in res).toBe(true);
    expect((res as MemoryNotFoundResponse).error).toBe("MemoryNotFound");
    expect((res as MemoryNotFoundResponse).id).toBe("mem_does_not_exist");
  });

  it("consolidate_memories counts written notes, not corpus", async () => {
    await backend.addMemoryNote({
      summary: "pending a",
      data_class: "internal",
      session_id: "ses_sqlite_consA_0001"
    });
    await backend.addMemoryNote({
      summary: "pending b",
      data_class: "public",
      session_id: "ses_sqlite_consA_0001"
    });
    const first = (await backend.consolidateMemories({})) as ConsolidateMemoriesResponse;
    expect(first.consolidated_count).toBe(2);
    expect(first.pending_count).toBe(0);
    const again = (await backend.consolidateMemories({})) as ConsolidateMemoriesResponse;
    expect(again.consolidated_count).toBe(0);
  });
});

describe("delete_memory_note — §8.1 idempotent tombstone contract", () => {
  it("first call: returns deleted=true + fresh tombstone_id + deleted_at", async () => {
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const firstCorpusId = loadCorpus()[0]!.note_id;
    const res = (await backend.deleteMemoryNote({
      id: firstCorpusId,
      reason: "test-deletion"
    })) as DeleteMemoryNoteResponse;
    expect(res.deleted).toBe(true);
    expect(res.tombstone_id).toMatch(/^tomb_[0-9a-f]{12}$/);
    expect(res.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("idempotency: repeat delete with same id returns identical tombstone_id + deleted_at", async () => {
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const id = loadCorpus()[0]!.note_id;
    const first = (await backend.deleteMemoryNote({ id, reason: "first" })) as DeleteMemoryNoteResponse;
    const second = (await backend.deleteMemoryNote({ id, reason: "second" })) as DeleteMemoryNoteResponse;
    const third = (await backend.deleteMemoryNote({ id })) as DeleteMemoryNoteResponse;
    expect(second.tombstone_id).toBe(first.tombstone_id);
    expect(second.deleted_at).toBe(first.deleted_at);
    expect(third.tombstone_id).toBe(first.tombstone_id);
    expect(third.deleted_at).toBe(first.deleted_at);

    const ts = backend.tombstoneFor(id)!;
    expect(ts.tombstone_id).toBe(first.tombstone_id);
    expect(ts.reason).toBe("first");
  });

  it("search_memories must NOT return tombstoned ids", async () => {
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const ids = loadCorpus().map((n) => n.note_id);
    for (const id of ids.slice(0, 3)) {
      await backend.deleteMemoryNote({ id, reason: "cleanup" });
    }
    const search = (await backend.searchMemories({
      query: "agent card",
      limit: 50
    })) as SearchMemoriesResponse;
    for (const hit of search.hits) {
      expect(ids.slice(0, 3)).not.toContain(hit.note_id);
    }
  });

  it("unknown id: returns error sentinel (MemoryNotFound via mock-error)", async () => {
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const res = (await backend.deleteMemoryNote({
      id: "mem_does_not_exist",
      reason: "x"
    })) as { error: string };
    expect(res.error).toBe("mock-error");
  });

  it("error injection: errorForTool=delete_memory_note returns mock-error", async () => {
    const backend = freshBackend({
      seedCorpus: loadCorpus(),
      errorForTool: "delete_memory_note"
    });
    const id = loadCorpus()[0]!.note_id;
    const res = (await backend.deleteMemoryNote({ id })) as { error: string };
    expect(res.error).toBe("mock-error");
  });
});

describe("fault injection + env parsing", () => {
  it("parseSqliteEnv: valid env values; junk raises", () => {
    expect(parseSqliteEnv({})).toEqual({});
    expect(parseSqliteEnv({ SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS: "3" })).toEqual({
      timeoutAfterNCalls: 3
    });
    expect(parseSqliteEnv({ SOA_MEMORY_MCP_SQLITE_RETURN_ERROR: "search_memories" })).toEqual({
      errorForTool: "search_memories"
    });
    expect(parseSqliteEnv({ SOA_MEMORY_MCP_SQLITE_DB: "./x.sqlite" })).toEqual({
      dbPath: "./x.sqlite"
    });
    expect(() =>
      parseSqliteEnv({ SOA_MEMORY_MCP_SQLITE_TIMEOUT_AFTER_N_CALLS: "bogus" })
    ).toThrow(/non-negative integer/);
    expect(() => parseSqliteEnv({ SOA_MEMORY_MCP_SQLITE_RETURN_ERROR: "bad-tool" })).toThrow(
      /must name a tool/
    );
  });

  it("timeout-after-N: shouldTimeout flips true after N calls (HR-17 substrate)", async () => {
    const backend = freshBackend({ seedCorpus: loadCorpus(), timeoutAfterNCalls: 2 });
    expect(backend.shouldTimeout()).toBe(false);
    await backend.searchMemories({ query: "q" });
    expect(backend.shouldTimeout()).toBe(false);
    await backend.searchMemories({ query: "q" });
    expect(backend.shouldTimeout()).toBe(true);
  });

  it("timeout-after-0: every call times out immediately", () => {
    const backend = new SqliteMemoryBackend({ dbPath: ":memory:", timeoutAfterNCalls: 0 });
    expect(backend.shouldTimeout()).toBe(true);
    expect(backend.invocationCount()).toBe(0);
  });

  it("errorForTool routes named tool to mock-error", async () => {
    const backend = freshBackend({
      seedCorpus: loadCorpus(),
      errorForTool: "add_memory_note"
    });
    const s = await backend.searchMemories({ query: "anything" });
    expect("error" in s).toBe(false);
    const a = await backend.addMemoryNote({
      summary: "x",
      data_class: "public",
      session_id: "ses_err00000000000001"
    });
    expect("error" in a).toBe(true);
    expect((a as { error: string }).error).toBe("mock-error");
  });
});

describe("HTTP server integration", () => {
  it("GET /health + POST /search_memories route through the backend", async () => {
    const { buildSqliteServer } = await import("../src/server.js");
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const app = await buildSqliteServer({ backend });
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
      expect(body.hits).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("POST /delete_memory_note routes to the backend and is HTTP-idempotent", async () => {
    const { buildSqliteServer } = await import("../src/server.js");
    const backend = freshBackend({ seedCorpus: loadCorpus() });
    const app = await buildSqliteServer({ backend });
    const id = loadCorpus()[0]!.note_id;
    try {
      const first = await app.inject({
        method: "POST",
        url: "/delete_memory_note",
        headers: { "content-type": "application/json" },
        payload: { id, reason: "http-test" }
      });
      expect(first.statusCode).toBe(200);
      const body = JSON.parse(first.body) as DeleteMemoryNoteResponse;
      expect(body.deleted).toBe(true);
      expect(body.tombstone_id).toMatch(/^tomb_[0-9a-f]{12}$/);

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
