import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  SqliteMemoryBackend,
  buildSqliteServer,
  type CorpusSeedEntry,
  type SearchMemoriesResponse,
  type AddMemoryNoteResponse,
  type ReadMemoryNoteResponse,
  type ConsolidateMemoriesResponse,
  type DeleteMemoryNoteResponse,
  type SearchMemoriesByTimeResponse
} from "../src/index.js";

// Conformance test — drives the §8.1 six-tool surface against a
// live-in-process HTTP instance and ajv-validates every response.
// Mirrors the Gate 4 Zep spike's ajv-pass-rate bar (100% of checked
// responses) but against the sqlite backend that will actually ship.

const here = dirname(fileURLToPath(import.meta.url));
const SEED = join(
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
  return (JSON.parse(readFileSync(SEED, "utf8")) as { notes: CorpusSeedEntry[] }).notes;
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS = {
  searchMemories: {
    type: "object",
    required: ["hits"],
    properties: {
      hits: {
        type: "array",
        items: {
          type: "object",
          required: ["note_id", "summary", "data_class", "composite_score"],
          properties: {
            note_id: { type: "string" },
            summary: { type: "string" },
            data_class: { enum: ["public", "internal", "confidential", "personal"] },
            composite_score: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    }
  },
  searchMemoriesByTime: {
    type: "object",
    required: ["hits", "truncated"],
    properties: {
      hits: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "created_at", "tags"],
          properties: {
            id: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            tags: { type: "array", items: { type: "string" } }
          }
        }
      },
      truncated: { type: "boolean" }
    }
  },
  addMemoryNote: {
    type: "object",
    required: ["note_id", "created_at"],
    properties: {
      note_id: { type: "string", pattern: "^mem_" },
      created_at: { type: "string", format: "date-time" }
    }
  },
  readMemoryNote: {
    oneOf: [
      {
        type: "object",
        required: ["id", "note", "tags", "importance", "created_at", "graph_edges"],
        properties: {
          id: { type: "string" },
          note: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "number" },
          created_at: { type: "string", format: "date-time" },
          graph_edges: { type: "array" }
        }
      },
      {
        type: "object",
        required: ["error", "id"],
        properties: { error: { const: "MemoryNotFound" }, id: { type: "string" } }
      }
    ]
  },
  consolidateMemories: {
    type: "object",
    required: ["consolidated_count", "pending_count"],
    properties: {
      consolidated_count: { type: "integer", minimum: 0 },
      pending_count: { type: "integer", minimum: 0 }
    }
  },
  deleteMemoryNote: {
    type: "object",
    required: ["deleted", "tombstone_id", "deleted_at"],
    properties: {
      deleted: { const: true },
      tombstone_id: { type: "string", pattern: "^tomb_[0-9a-f]{12}$" },
      deleted_at: { type: "string", format: "date-time" }
    }
  }
};

const validators = Object.fromEntries(
  Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)])
);

describe("ajv conformance — §8.1 response shapes", () => {
  let backend: SqliteMemoryBackend;

  beforeEach(() => {
    backend = new SqliteMemoryBackend({ dbPath: ":memory:", seedCorpus: loadCorpus() });
  });

  it("all 6 tool responses validate against their §8.1 shapes (100% pass rate)", async () => {
    const app = await buildSqliteServer({ backend });
    try {
      const added = (await backend.addMemoryNote({
        summary: "conformance test seed",
        data_class: "internal",
        session_id: "ses_conformance000001",
        note_id: "mem_conformance01"
      })) as AddMemoryNoteResponse;
      expect(validators.addMemoryNote(added)).toBe(true);

      const search = (await backend.searchMemories({
        query: "conformance",
        limit: 5
      })) as SearchMemoriesResponse;
      expect(validators.searchMemories(search)).toBe(true);

      const byTime = (await backend.searchMemoriesByTime({
        start: "2025-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
        limit: 50
      })) as SearchMemoriesByTimeResponse;
      expect(validators.searchMemoriesByTime(byTime)).toBe(true);

      const read = (await backend.readMemoryNote({
        id: "mem_conformance01"
      })) as ReadMemoryNoteResponse;
      expect(validators.readMemoryNote(read)).toBe(true);

      const consolidate = (await backend.consolidateMemories({})) as ConsolidateMemoriesResponse;
      expect(validators.consolidateMemories(consolidate)).toBe(true);

      const deleted = (await backend.deleteMemoryNote({
        id: "mem_conformance01",
        reason: "conformance-cleanup"
      })) as DeleteMemoryNoteResponse;
      expect(validators.deleteMemoryNote(deleted)).toBe(true);

      // MemoryNotFound shape for read
      const nf = await backend.readMemoryNote({ id: "mem_does_not_exist_00" });
      expect(validators.readMemoryNote(nf)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("HTTP transport preserves §8.1 shape end-to-end", async () => {
    const app = await buildSqliteServer({ backend });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/search_memories",
        headers: { "content-type": "application/json" },
        payload: { query: "budget", limit: 3 }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(validators.searchMemories(body)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
