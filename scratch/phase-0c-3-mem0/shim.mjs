// M5 Phase 0c Gate 3 — mem0 backend feasibility shim.
// Exposes §8.1 six-tool surface over HTTP, backed by mem0 → Qdrant → Ollama.
// L-56 pass criterion (revised): SV-MEM-01..08 + HR-17 on this shim.

import Fastify from "fastify";
import { Memory } from "mem0ai/oss";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8002);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const DEFAULT_USER = "soa-harness-gate3";

const memory = new Memory({
  llm: {
    provider: "ollama",
    config: { model: "llama3.1", url: OLLAMA_URL, temperature: 0 }
  },
  embedder: {
    provider: "ollama",
    config: { model: "nomic-embed-text", url: OLLAMA_URL, embeddingDims: 768 }
  },
  vectorStore: {
    provider: "qdrant",
    config: {
      collectionName: "soa_gate3",
      embeddingModelDims: 768,
      host: "localhost",
      port: 6333
    }
  },
  disableHistory: true
});

// mem0 IDs are UUIDs; §8.1 wants /^mem_[0-9a-f]{12}$/. Bidirectional map
// using a 12-hex prefix derived from a SHA-256 of the mem0 id — stable
// across process lifetime. Collisions in 48 bits are non-issues for
// a test corpus.
const memoFromExternal = new Map(); // mem_xxxxxxxxxxxx → mem0 UUID
const memoToExternal = new Map(); // mem0 UUID → mem_xxxxxxxxxxxx
const tombstones = new Map(); // external id → { tombstone_id, deleted_at, reason }
const noteData = new Map(); // external id → { summary, data_class, created_at, session_id }

function toExternal(mem0Id) {
  if (memoToExternal.has(mem0Id)) return memoToExternal.get(mem0Id);
  const hex = createHash("sha256").update(mem0Id).digest("hex").slice(0, 12);
  const ext = `mem_${hex}`;
  memoToExternal.set(mem0Id, ext);
  memoFromExternal.set(ext, mem0Id);
  return ext;
}

function mintTombstoneId() {
  return `tomb_${randomBytes(6).toString("hex")}`;
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ status: "alive" }));

app.post("/search_memories", async (req, reply) => {
  const { query, limit = 10 } = req.body ?? {};
  // Ollama embedders refuse empty strings. Short-circuit with empty hits
  // rather than propagating the embedder error — the Runner's startup
  // probe hits this path with placeholder queries.
  if (!query || query.trim().length === 0) {
    return reply.send({ hits: [] });
  }
  try {
    const res = await memory.search(query, {
      userId: DEFAULT_USER,
      limit
    });
    const hits = (res.results ?? [])
      .filter((r) => !tombstones.has(toExternal(r.id)))
      .map((r) => ({
        note_id: toExternal(r.id),
        summary: r.memory,
        data_class: r.metadata?.data_class ?? "internal",
        composite_score: Math.min(1, Math.max(0, r.score ?? 0))
      }));
    return reply.send({ hits });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "mock-error", detail: String(err) });
  }
});

app.post("/search_memories_by_time", async (req, reply) => {
  const { start, end, limit = 50 } = req.body ?? {};
  const startT = Date.parse(start);
  const endT = Date.parse(end);
  const res = await memory.getAll({ userId: DEFAULT_USER, limit: 1000 });
  const filtered = (res.results ?? [])
    .map((r) => {
      const ext = toExternal(r.id);
      const cached = noteData.get(ext);
      return {
        note_id: ext,
        created_at: cached?.created_at ?? r.createdAt ?? new Date(0).toISOString(),
        summary: r.memory,
        data_class: r.metadata?.data_class ?? "internal"
      };
    })
    .filter((h) => !tombstones.has(h.note_id))
    .filter((h) => {
      const t = Date.parse(h.created_at);
      return t >= startT && t <= endT;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const truncated = filtered.length > limit;
  return reply.send({ hits: filtered.slice(0, limit), truncated });
});

app.post("/add_memory_note", async (req, reply) => {
  const { summary, data_class = "internal", session_id, note_id } = req.body ?? {};
  try {
    const res = await memory.add(summary, {
      userId: DEFAULT_USER,
      metadata: { data_class, session_id, external_id: note_id ?? null },
      infer: false
    });
    const mem0Id = res.results?.[0]?.id ?? randomBytes(8).toString("hex");
    const ext = note_id ?? toExternal(mem0Id);
    memoFromExternal.set(ext, mem0Id);
    memoToExternal.set(mem0Id, ext);
    noteData.set(ext, {
      summary,
      data_class,
      session_id,
      created_at: new Date().toISOString()
    });
    return reply.send({ note_id: ext });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "mock-error", detail: String(err) });
  }
});

app.post("/read_memory_note", async (req, reply) => {
  const { id } = req.body ?? {};
  const mem0Id = memoFromExternal.get(id);
  if (!mem0Id || tombstones.has(id)) {
    return reply.send({ error: "MemoryNotFound", id });
  }
  const item = await memory.get(mem0Id);
  if (!item) return reply.send({ error: "MemoryNotFound", id });
  const cached = noteData.get(id) ?? {};
  return reply.send({
    id,
    note: item.memory,
    tags: item.metadata?.tags ?? [],
    importance: item.metadata?.importance ?? 0.5,
    created_at: cached.created_at ?? item.createdAt ?? new Date(0).toISOString(),
    graph_edges: []
  });
});

app.post("/consolidate_memories", async (_req, reply) => {
  // mem0 auto-consolidates via its history store / dedup during add();
  // surface zero pending, total count as "consolidated" from this call's
  // perspective. This is a best-effort mapping — the real §8.4 semantics
  // are enforced Runner-side.
  const all = await memory.getAll({ userId: DEFAULT_USER, limit: 10000 });
  return reply.send({
    consolidated_count: all.results?.length ?? 0,
    pending_count: 0
  });
});

app.post("/delete_memory_note", async (req, reply) => {
  const { id, reason } = req.body ?? {};
  const mem0Id = memoFromExternal.get(id);
  if (!mem0Id) return reply.send({ error: "MemoryNotFound", id });
  if (tombstones.has(id)) {
    const t = tombstones.get(id);
    return reply.send({
      deleted: true,
      tombstone_id: t.tombstone_id,
      deleted_at: t.deleted_at
    });
  }
  try {
    await memory.delete(mem0Id);
  } catch (err) {
    req.log.error(err);
  }
  const ts = {
    tombstone_id: mintTombstoneId(),
    deleted_at: new Date().toISOString(),
    reason: reason ?? null
  };
  tombstones.set(id, ts);
  return reply.send({ deleted: true, tombstone_id: ts.tombstone_id, deleted_at: ts.deleted_at });
});

app.listen({ port: PORT, host: "127.0.0.1" })
  .then(() => console.log(`[gate3-mem0-shim] listening on :${PORT}`))
  .catch((err) => {
    console.error("[gate3-mem0-shim] startup failed:", err);
    process.exit(1);
  });
