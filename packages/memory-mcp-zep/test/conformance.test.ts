import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  ZepBackend,
  buildZepServer,
  type AddMemoryNoteResponse,
  type ConsolidateMemoriesResponse,
  type DeleteMemoryNoteResponse,
  type MemoryDeletionForbiddenResponse,
  type ReadMemoryNoteResponse,
  type SearchMemoriesByTimeResponse,
  type SearchMemoriesResponse
} from "../src/index.js";
import { createFakeZepCollection } from "./fake-zep-collection.js";

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
            data_class: {
              enum: ["public", "internal", "confidential", "personal", "sensitive-personal"]
            },
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
  },
  memoryDeletionForbidden: {
    type: "object",
    required: ["error", "reason"],
    properties: {
      error: { const: "MemoryDeletionForbidden" },
      reason: { const: "sensitive-class-forbidden" }
    }
  }
};
const validators = Object.fromEntries(
  Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)])
);

describe("ajv conformance — §8.1 + L-58 response shapes (Zep)", () => {
  it("all 6 tool responses + sensitive-personal validate (100% pass rate)", async () => {
    const backend = new ZepBackend({ collection: createFakeZepCollection() });
    const app = await buildZepServer({ backend });
    try {
      const added = (await backend.addMemoryNote({
        summary: "conformance seed",
        data_class: "internal",
        session_id: "ses_zep_conf000001",
        note_id: "mem_zep_conf01"
      })) as AddMemoryNoteResponse;
      expect(validators.addMemoryNote(added)).toBe(true);

      const search = (await backend.searchMemories({
        query: "conformance",
        limit: 5
      })) as SearchMemoriesResponse;
      expect(validators.searchMemories(search)).toBe(true);

      const byTime = (await backend.searchMemoriesByTime({
        start: "2025-01-01T00:00:00Z",
        end: "2030-01-01T00:00:00Z",
        limit: 50
      })) as SearchMemoriesByTimeResponse;
      expect(validators.searchMemoriesByTime(byTime)).toBe(true);

      const read = (await backend.readMemoryNote({
        id: "mem_zep_conf01"
      })) as ReadMemoryNoteResponse;
      expect(validators.readMemoryNote(read)).toBe(true);

      const nf = await backend.readMemoryNote({ id: "mem_does_not_exist_z" });
      expect(validators.readMemoryNote(nf)).toBe(true);

      const consolidate = (await backend.consolidateMemories({})) as ConsolidateMemoriesResponse;
      expect(validators.consolidateMemories(consolidate)).toBe(true);

      const deleted = (await backend.deleteMemoryNote({
        id: "mem_zep_conf01",
        reason: "conformance-cleanup"
      })) as DeleteMemoryNoteResponse;
      expect(validators.deleteMemoryNote(deleted)).toBe(true);

      const forbidden = (await backend.addMemoryNote({
        summary: "SSN secret",
        data_class: "sensitive-personal",
        session_id: "ses_zep_conf_pii_001"
      })) as MemoryDeletionForbiddenResponse;
      expect(validators.memoryDeletionForbidden(forbidden)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
