import { describe, it, expect, beforeEach } from "vitest";
import {
  ZepBackend,
  parseZepEnv,
  type AddMemoryNoteResponse,
  type ConsolidateMemoriesResponse,
  type DeleteMemoryNoteResponse,
  type MemoryDeletionForbiddenResponse,
  type MemoryNotFoundResponse,
  type ReadMemoryNoteResponse,
  type SearchMemoriesByTimeResponse,
  type SearchMemoriesResponse
} from "../src/index.js";
import { createFakeZepCollection } from "./fake-zep-collection.js";

function freshBackend(opts: Partial<ConstructorParameters<typeof ZepBackend>[0]> = {}) {
  return new ZepBackend({ collection: createFakeZepCollection(), ...opts });
}

describe("ZepBackend — §8.1 six-tool protocol", () => {
  let backend: ZepBackend;

  beforeEach(() => {
    backend = freshBackend();
  });

  it("add_memory_note returns {note_id, created_at} per L-58", async () => {
    const res = (await backend.addMemoryNote({
      summary: "budget projection note",
      data_class: "internal",
      session_id: "ses_zep_add00000001",
      note_id: "mem_zepadd00001"
    })) as AddMemoryNoteResponse;
    expect(res.note_id).toBe("mem_zepadd00001");
    expect(res.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("add_memory_note is idempotent with stable created_at (L-58)", async () => {
    const first = (await backend.addMemoryNote({
      summary: "pin note",
      data_class: "public",
      session_id: "ses_zep_idem00000001",
      note_id: "mem_zepidem0001"
    })) as AddMemoryNoteResponse;
    const second = (await backend.addMemoryNote({
      summary: "pin note again",
      data_class: "public",
      session_id: "ses_zep_idem00000001",
      note_id: "mem_zepidem0001"
    })) as AddMemoryNoteResponse;
    expect(second.note_id).toBe(first.note_id);
    expect(second.created_at).toBe(first.created_at);
  });

  it("add_memory_note rejects data_class=sensitive-personal BEFORE Zep call (L-58)", async () => {
    const fake = createFakeZepCollection();
    const b = new ZepBackend({ collection: fake });
    const res = (await b.addMemoryNote({
      summary: "SSN 000-00-0000",
      data_class: "sensitive-personal",
      session_id: "ses_zep_pii000000001",
      note_id: "mem_piizep001"
    })) as MemoryDeletionForbiddenResponse;
    expect(res.error).toBe("MemoryDeletionForbidden");
    expect(res.reason).toBe("sensitive-class-forbidden");
    expect(fake.__size()).toBe(0);
  });

  it("add_memory_note persists tags + importance", async () => {
    await backend.addMemoryNote({
      summary: "tagged note",
      data_class: "internal",
      session_id: "ses_zep_tags00000001",
      note_id: "mem_zeptag_0001",
      tags: ["alpha", "beta"],
      importance: 0.7
    });
    const read = (await backend.readMemoryNote({ id: "mem_zeptag_0001" })) as ReadMemoryNoteResponse;
    expect(read.tags.sort()).toEqual(["alpha", "beta"]);
    expect(read.importance).toBe(0.7);
  });

  it("search_memories returns scored hits + empty-query short-circuit", async () => {
    await backend.addMemoryNote({
      summary: "alpha budget item",
      data_class: "internal",
      session_id: "ses_zep_search_0001",
      note_id: "mem_zep_s_a"
    });
    const hit = (await backend.searchMemories({ query: "budget", limit: 5 })) as SearchMemoriesResponse;
    expect(hit.hits.length).toBeGreaterThan(0);
    const empty = (await backend.searchMemories({ query: "", limit: 5 })) as SearchMemoriesResponse;
    expect(empty.hits).toEqual([]);
  });

  it("search_memories excludes tombstoned ids", async () => {
    await backend.addMemoryNote({
      summary: "to be deleted",
      data_class: "internal",
      session_id: "ses_zep_tomb00000001",
      note_id: "mem_zep_tomb_1"
    });
    await backend.deleteMemoryNote({ id: "mem_zep_tomb_1", reason: "cleanup" });
    const s = (await backend.searchMemories({ query: "deleted", limit: 10 })) as SearchMemoriesResponse;
    expect(s.hits.find((h) => h.note_id === "mem_zep_tomb_1")).toBeUndefined();
  });

  it("search_memories_by_time filters by RFC 3339 window", async () => {
    await backend.addMemoryNote({
      summary: "t-window note",
      data_class: "internal",
      session_id: "ses_zep_time00000001",
      note_id: "mem_zep_time_1"
    });
    const res = (await backend.searchMemoriesByTime({
      start: "2025-01-01T00:00:00Z",
      end: "2030-01-01T00:00:00Z"
    })) as SearchMemoriesByTimeResponse;
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(false);
  });

  it("read_memory_note: unknown id → MemoryNotFound", async () => {
    const res = await backend.readMemoryNote({ id: "mem_does_not_exist" });
    expect((res as MemoryNotFoundResponse).error).toBe("MemoryNotFound");
  });

  it("consolidate_memories returns counts", async () => {
    await backend.addMemoryNote({
      summary: "cons-1",
      data_class: "internal",
      session_id: "ses_zep_cons00000001",
      note_id: "mem_zep_cons_1"
    });
    const res = (await backend.consolidateMemories({})) as ConsolidateMemoriesResponse;
    expect(res.consolidated_count).toBeGreaterThanOrEqual(1);
    expect(res.pending_count).toBe(0);
  });
});

describe("delete_memory_note — §8.1 idempotent tombstone contract", () => {
  it("first delete returns fresh tombstone_id + deleted_at", async () => {
    const backend = freshBackend();
    await backend.addMemoryNote({
      summary: "tomb-first",
      data_class: "internal",
      session_id: "ses_zep_tdelete0001",
      note_id: "mem_zep_tdel01"
    });
    const res = (await backend.deleteMemoryNote({
      id: "mem_zep_tdel01",
      reason: "test"
    })) as DeleteMemoryNoteResponse;
    expect(res.deleted).toBe(true);
    expect(res.tombstone_id).toMatch(/^tomb_[0-9a-f]{12}$/);
    expect(res.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("repeat delete is idempotent (same tombstone_id + deleted_at)", async () => {
    const backend = freshBackend();
    await backend.addMemoryNote({
      summary: "tomb-idem",
      data_class: "internal",
      session_id: "ses_zep_tidem000001",
      note_id: "mem_zep_tidem1"
    });
    const first = (await backend.deleteMemoryNote({
      id: "mem_zep_tidem1",
      reason: "first"
    })) as DeleteMemoryNoteResponse;
    const second = (await backend.deleteMemoryNote({
      id: "mem_zep_tidem1"
    })) as DeleteMemoryNoteResponse;
    expect(second.tombstone_id).toBe(first.tombstone_id);
    expect(second.deleted_at).toBe(first.deleted_at);
  });

  it("unknown id: returns mock-error sentinel", async () => {
    const backend = freshBackend();
    const res = (await backend.deleteMemoryNote({ id: "mem_never_existed" })) as {
      error: string;
    };
    expect(res.error).toBe("mock-error");
  });
});

describe("fault injection + env parsing", () => {
  it("parseZepEnv: valid + junk", () => {
    expect(parseZepEnv({})).toEqual({});
    expect(parseZepEnv({ SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS: "3" })).toEqual({
      timeoutAfterNCalls: 3
    });
    expect(parseZepEnv({ SOA_MEMORY_MCP_ZEP_RETURN_ERROR: "search_memories" })).toEqual({
      errorForTool: "search_memories"
    });
    expect(parseZepEnv({ SOA_MEMORY_MCP_ZEP_COLLECTION: "goodalphanum123" })).toEqual({
      collection: "goodalphanum123"
    });
    expect(() =>
      parseZepEnv({ SOA_MEMORY_MCP_ZEP_TIMEOUT_AFTER_N_CALLS: "bogus" })
    ).toThrow(/non-negative integer/);
    expect(() => parseZepEnv({ SOA_MEMORY_MCP_ZEP_RETURN_ERROR: "bad-tool" })).toThrow(
      /must name a tool/
    );
    expect(() => parseZepEnv({ SOA_MEMORY_MCP_ZEP_COLLECTION: "bad_name" })).toThrow(
      /alphanum-only/
    );
  });

  it("timeout-after-N: shouldTimeout flips true after N calls", async () => {
    const backend = freshBackend({ timeoutAfterNCalls: 2 });
    expect(backend.shouldTimeout()).toBe(false);
    await backend.searchMemories({ query: "q" });
    expect(backend.shouldTimeout()).toBe(false);
    await backend.searchMemories({ query: "q" });
    expect(backend.shouldTimeout()).toBe(true);
  });

  it("errorForTool routes named tool to mock-error", async () => {
    const backend = freshBackend({ errorForTool: "add_memory_note" });
    const s = await backend.searchMemories({ query: "anything" });
    expect("error" in s).toBe(false);
    const a = await backend.addMemoryNote({
      summary: "x",
      data_class: "public",
      session_id: "ses_zep_err00000001"
    });
    expect("error" in a).toBe(true);
    expect((a as { error: string }).error).toBe("mock-error");
  });
});

describe("HTTP server integration", () => {
  it("GET /health + POST /search_memories route through the backend", async () => {
    const { buildZepServer } = await import("../src/server.js");
    const backend = freshBackend();
    await backend.addMemoryNote({
      summary: "http route test",
      data_class: "internal",
      session_id: "ses_zep_http00000001",
      note_id: "mem_zep_http01"
    });
    const app = await buildZepServer({ backend });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "alive" });

      const search = await app.inject({
        method: "POST",
        url: "/search_memories",
        headers: { "content-type": "application/json" },
        payload: { query: "http", limit: 2 }
      });
      expect(search.statusCode).toBe(200);
      const body = JSON.parse(search.body) as SearchMemoriesResponse;
      expect(body.hits.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("POST /add_memory_note rejects sensitive-personal via HTTP (L-58)", async () => {
    const { buildZepServer } = await import("../src/server.js");
    const backend = freshBackend();
    const app = await buildZepServer({ backend });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/add_memory_note",
        headers: { "content-type": "application/json" },
        payload: {
          summary: "SSN leak",
          data_class: "sensitive-personal",
          session_id: "ses_zep_pii_http_001"
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("MemoryDeletionForbidden");
      expect(body.reason).toBe("sensitive-class-forbidden");
    } finally {
      await app.close();
    }
  });
});
