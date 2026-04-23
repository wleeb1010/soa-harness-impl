// M5 Phase 0c Gate 4 — Zep backend feasibility shim.
// §8.1 six-tool HTTP surface mapped onto Zep's Document Collection API,
// backed by docker-compose'd Zep v0.27.2 + Postgres + NLP server.
// L-56 Gate 4 pass criterion: ≤300 LOC + 100% ajv validation against
// §8.1-shaped responses.

import Fastify from "fastify";
import { ZepClient } from "@getzep/zep-js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8004);
const ZEP_URL = process.env.ZEP_URL ?? "http://localhost:8003";
const COLLECTION = "soagate4notes";

// --- ajv schemas for §8.1 response shapes ------------------------------
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
            note_id: { type: "string", pattern: "^mem_[0-9a-f]{12}$" },
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
          required: ["note_id", "created_at"],
          properties: {
            note_id: { type: "string", pattern: "^mem_[0-9a-f]{12}$" },
            created_at: { type: "string", format: "date-time" },
            summary: { type: "string" },
            data_class: { enum: ["public", "internal", "confidential", "personal"] }
          }
        }
      },
      truncated: { type: "boolean" }
    }
  },
  addMemoryNote: {
    type: "object",
    required: ["note_id"],
    properties: {
      note_id: { type: "string", pattern: "^mem_[0-9a-f]{12}$" }
    }
  },
  readMemoryNote: {
    oneOf: [
      {
        type: "object",
        required: ["id", "note", "tags", "importance", "created_at", "graph_edges"],
        properties: {
          id: { type: "string", pattern: "^mem_[0-9a-f]{12}$" },
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
    oneOf: [
      {
        type: "object",
        required: ["deleted", "tombstone_id", "deleted_at"],
        properties: {
          deleted: { const: true },
          tombstone_id: { type: "string", pattern: "^tomb_[0-9a-f]{12}$" },
          deleted_at: { type: "string", format: "date-time" }
        }
      },
      {
        type: "object",
        required: ["error", "id"],
        properties: { error: { const: "MemoryNotFound" }, id: { type: "string" } }
      }
    ]
  }
};
const validators = Object.fromEntries(
  Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)])
);
const ajvMetrics = { passes: 0, failures: 0, details: [] };
function validate(tool, resp) {
  const v = validators[tool];
  const ok = v(resp);
  if (ok) ajvMetrics.passes++;
  else {
    ajvMetrics.failures++;
    ajvMetrics.details.push({ tool, errors: v.errors });
  }
  return resp;
}

// --- id mapping + tombstone tracking -----------------------------------
const uuidByMemId = new Map(); // mem_xxx → Zep uuid
const memIdByUuid = new Map(); // Zep uuid → mem_xxx
const tombstones = new Map(); // mem_xxx → { tombstone_id, deleted_at, reason }

function mintMemId(seed) {
  const h = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `mem_${h}`;
}
function mintTombstoneId() {
  return `tomb_${randomBytes(6).toString("hex")}`;
}

// --- Zep bootstrap -----------------------------------------------------
const zep = await ZepClient.init(ZEP_URL);
try {
  await zep.document.getCollection(COLLECTION);
} catch (err) {
  if (String(err).includes("NotFound") || /404/.test(String(err))) {
    await zep.document.addCollection({
      name: COLLECTION,
      embeddingDimensions: 384,
      isAutoEmbedded: true,
      description: "SOA-Harness §8.1 note store — Gate 4 spike"
    });
  } else throw err;
}
const collection = await zep.document.getCollection(COLLECTION);

// --- HTTP surface ------------------------------------------------------
const app = Fastify({ logger: false });
app.get("/health", async () => ({ status: "alive" }));
app.get("/ajv-metrics", async () => ({ ...ajvMetrics }));

app.post("/search_memories", async (req, reply) => {
  const { query, limit = 10 } = req.body ?? {};
  if (!query || query.trim().length === 0) {
    return reply.send(validate("searchMemories", { hits: [] }));
  }
  try {
    const results = await collection.search({ text: query }, limit);
    const hits = results
      .map((d) => ({
        note_id: memIdByUuid.get(d.uuid) ?? mintMemId(d.uuid ?? d.document_id ?? ""),
        summary: d.content,
        data_class: d.metadata?.data_class ?? "internal",
        composite_score: Math.max(0, Math.min(1, d.score ?? 0))
      }))
      .filter((h) => !tombstones.has(h.note_id));
    return reply.send(validate("searchMemories", { hits }));
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "mock-error", detail: String(err) });
  }
});

app.post("/search_memories_by_time", async (req, reply) => {
  const { start, end, limit = 50 } = req.body ?? {};
  const startT = Date.parse(start);
  const endT = Date.parse(end);
  const all = Array.from(uuidByMemId.entries());
  const uuids = all.map(([, u]) => u);
  const docs = uuids.length ? await collection.getDocuments(uuids) : [];
  const filtered = docs
    .map((d) => ({
      note_id: memIdByUuid.get(d.uuid) ?? mintMemId(d.uuid ?? ""),
      created_at: d.metadata?.created_at ?? new Date(0).toISOString(),
      summary: d.content,
      data_class: d.metadata?.data_class ?? "internal"
    }))
    .filter((h) => !tombstones.has(h.note_id))
    .filter((h) => {
      const t = Date.parse(h.created_at);
      return t >= startT && t <= endT;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const truncated = filtered.length > limit;
  return reply.send(
    validate("searchMemoriesByTime", { hits: filtered.slice(0, limit), truncated })
  );
});

app.post("/add_memory_note", async (req, reply) => {
  const { summary, data_class = "internal", session_id, note_id } = req.body ?? {};
  const memId = note_id ?? mintMemId(`${session_id}:${summary}:${Date.now()}:${randomBytes(4).toString("hex")}`);
  const createdAt = new Date().toISOString();
  try {
    const [uuid] = await collection.addDocuments([
      {
        content: summary,
        document_id: memId,
        metadata: { data_class, session_id, created_at: createdAt, mem_id: memId }
      }
    ]);
    uuidByMemId.set(memId, uuid);
    memIdByUuid.set(uuid, memId);
    return reply.send(validate("addMemoryNote", { note_id: memId }));
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "mock-error", detail: String(err) });
  }
});

app.post("/read_memory_note", async (req, reply) => {
  const { id } = req.body ?? {};
  const uuid = uuidByMemId.get(id);
  if (!uuid || tombstones.has(id)) {
    return reply.send(validate("readMemoryNote", { error: "MemoryNotFound", id }));
  }
  try {
    // Zep SDK v0.10.0's getDocument(uuid) builds a URL the server 404s on
    // (/document/{uuid} — server wants /document/uuid/{uuid}). Use
    // getDocuments([uuid]) instead, which uses /document/list/get (POST).
    const docs = await collection.getDocuments([uuid]);
    const doc = docs[0];
    if (!doc) return reply.send(validate("readMemoryNote", { error: "MemoryNotFound", id }));
    return reply.send(
      validate("readMemoryNote", {
        id,
        note: doc.content,
        tags: doc.metadata?.tags ?? [],
        importance: doc.metadata?.importance ?? 0.5,
        created_at: doc.metadata?.created_at ?? new Date(0).toISOString(),
        graph_edges: []
      })
    );
  } catch {
    return reply.send(validate("readMemoryNote", { error: "MemoryNotFound", id }));
  }
});

app.post("/consolidate_memories", async (_req, reply) => {
  return reply.send(
    validate("consolidateMemories", {
      consolidated_count: uuidByMemId.size,
      pending_count: 0
    })
  );
});

app.post("/delete_memory_note", async (req, reply) => {
  const { id, reason } = req.body ?? {};
  const uuid = uuidByMemId.get(id);
  if (!uuid) {
    return reply.send(validate("deleteMemoryNote", { error: "MemoryNotFound", id }));
  }
  if (tombstones.has(id)) {
    const t = tombstones.get(id);
    return reply.send(
      validate("deleteMemoryNote", {
        deleted: true,
        tombstone_id: t.tombstone_id,
        deleted_at: t.deleted_at
      })
    );
  }
  try {
    await collection.deleteDocument(uuid);
  } catch (err) {
    req.log.error(err);
  }
  const ts = {
    tombstone_id: mintTombstoneId(),
    deleted_at: new Date().toISOString(),
    reason: reason ?? null
  };
  tombstones.set(id, ts);
  return reply.send(
    validate("deleteMemoryNote", {
      deleted: true,
      tombstone_id: ts.tombstone_id,
      deleted_at: ts.deleted_at
    })
  );
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[gate4-zep-shim] listening on :${PORT} — Zep at ${ZEP_URL} collection=${COLLECTION}`);
