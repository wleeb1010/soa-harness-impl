/**
 * mem0-backed implementation of the §8.1 six-tool Memory MCP protocol.
 *
 * Pattern mirrors `@soa-harness/memory-mcp-sqlite`'s SqliteMemoryBackend:
 * the backend is framework-agnostic; `server.ts` wires it to Fastify.
 * The backend takes an injected `Mem0LikeClient` so unit tests can
 * exercise the protocol without standing up Qdrant + Ollama.
 *
 * Post-L-58 additions over the Gate 3 shim (scratch/phase-0c-3-mem0/):
 *   - sensitive-personal pre-filter on add_memory_note (§10.7.2 +
 *     §8.1 canonical errata); rejection happens BEFORE any bytes reach
 *     mem0's LLM extraction so the downstream model never sees the
 *     sensitive input.
 *   - created_at in add_memory_note response (§8.1 flat signature).
 *   - optional tags[] + importance persisted to mem0 metadata.
 *   - fault-injection env triad (timeout-after-N, RETURN_ERROR, SEED).
 *
 * ID translation: mem0 mints UUIDs; §8.1 wants `/^mem_[0-9a-f]{12}$/`.
 * The backend keeps a bidirectional map, stable across process lifetime.
 * Tombstones are tracked in-process (mem0 hard-deletes; re-delete
 * idempotency can't be served from mem0 alone).
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  AddMemoryNoteRequest,
  AddMemoryNoteResponse,
  ConsolidateMemoriesRequest,
  ConsolidateMemoriesResponse,
  CorpusSeedEntry,
  DataClass,
  DeleteMemoryNoteRequest,
  DeleteMemoryNoteResponse,
  MemoryDeletionForbiddenResponse,
  MemoryNotFoundResponse,
  MockErrorResponse,
  NoteHit,
  ReadMemoryNoteRequest,
  ReadMemoryNoteResponse,
  SearchMemoriesByTimeRequest,
  SearchMemoriesByTimeResponse,
  SearchMemoriesRequest,
  SearchMemoriesResponse,
  TimeRangeHit,
  ToolName
} from "./types.js";

/** Minimal mem0 surface the backend relies on. Real `Memory` instances
 *  satisfy this; unit tests inject in-memory fakes. */
export interface Mem0LikeItem {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface Mem0LikeClient {
  add(
    content: string,
    config: { userId: string; metadata?: Record<string, unknown>; infer?: boolean }
  ): Promise<{ results: Array<{ id: string }> }>;
  search(
    query: string,
    config: { userId: string; limit?: number }
  ): Promise<{ results: Mem0LikeItem[] }>;
  get(id: string): Promise<Mem0LikeItem | null>;
  getAll(config: { userId: string; limit?: number }): Promise<{ results: Mem0LikeItem[] }>;
  delete(id: string): Promise<unknown>;
}

export interface Mem0BackendOptions {
  client: Mem0LikeClient;
  timeoutAfterNCalls?: number;
  errorForTool?: ToolName | null;
  seedCorpus?: CorpusSeedEntry[];
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => Date;
  /** userId scope passed to mem0. Defaults to `"soa-harness"`. */
  userId?: string;
}

interface NoteRecord {
  summary: string;
  data_class: DataClass;
  session_id: string;
  created_at: string;
  tags: string[];
  importance: number;
}

export class Mem0Backend {
  private readonly client: Mem0LikeClient;
  private readonly timeoutAfterNCalls: number;
  private readonly errorForTool: ToolName | null;
  private readonly now: () => Date;
  private readonly userId: string;
  private callCount = 0;
  private readonly memByExternal = new Map<string, string>(); // mem_xxx → mem0 uuid
  private readonly externalByMem = new Map<string, string>(); // mem0 uuid → mem_xxx
  private readonly tombstones = new Map<
    string,
    { tombstone_id: string; deleted_at: string; reason: string }
  >();
  private readonly records = new Map<string, NoteRecord>();

  constructor(opts: Mem0BackendOptions) {
    this.client = opts.client;
    this.timeoutAfterNCalls = opts.timeoutAfterNCalls ?? -1;
    this.errorForTool = opts.errorForTool ?? null;
    this.now = opts.now ?? (() => new Date());
    this.userId = opts.userId ?? "soa-harness";
    if (opts.seedCorpus) void this.primeSeed(opts.seedCorpus);
  }

  private async primeSeed(seed: CorpusSeedEntry[]): Promise<void> {
    // Seed is best-effort: we pre-register ids in the local maps so
    // read_memory_note returns them; mem0 itself may not have the
    // content yet (the caller is expected to add() lazily).
    const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
    for (const e of seed) {
      const createdAt = new Date(EPOCH - e.recency_days_ago * 86400_000).toISOString();
      this.records.set(e.note_id, {
        summary: e.summary,
        data_class: e.data_class,
        session_id: "",
        created_at: createdAt,
        tags: [],
        importance: e.graph_strength
      });
    }
  }

  shouldTimeout(): boolean {
    if (this.timeoutAfterNCalls < 0) return false;
    return this.callCount >= this.timeoutAfterNCalls;
  }

  invocationCount(): number {
    return this.callCount;
  }

  private toExternal(mem0Id: string): string {
    const cached = this.externalByMem.get(mem0Id);
    if (cached) return cached;
    const hex = createHash("sha256").update(mem0Id).digest("hex").slice(0, 12);
    const ext = `mem_${hex}`;
    this.externalByMem.set(mem0Id, ext);
    this.memByExternal.set(ext, mem0Id);
    return ext;
  }

  async searchMemories(
    req: SearchMemoriesRequest
  ): Promise<SearchMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories") return { error: "mock-error" };
    // Ollama embedders refuse empty strings; short-circuit per the Runner
    // startup-probe canary path (Phase 0e).
    if (!req.query || req.query.trim().length === 0) return { hits: [] };

    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 10;
    try {
      const res = await this.client.search(req.query, { userId: this.userId, limit });
      const hits: NoteHit[] = [];
      for (const r of res.results ?? []) {
        const ext = this.externalByMem.get(r.id) ?? this.toExternal(r.id);
        if (this.tombstones.has(ext)) continue;
        const rec = this.records.get(ext);
        hits.push({
          note_id: ext,
          summary: r.memory,
          data_class: (r.metadata?.["data_class"] as DataClass) ?? rec?.data_class ?? "internal",
          composite_score: Math.max(0, Math.min(1, r.score ?? 0))
        });
      }
      return { hits };
    } catch (err) {
      return { error: "mock-error", detail: String(err) } as MockErrorResponse & {
        detail: string;
      };
    }
  }

  async searchMemoriesByTime(
    req: SearchMemoriesByTimeRequest
  ): Promise<SearchMemoriesByTimeResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories_by_time") return { error: "mock-error" };
    const startMs = Date.parse(req.start);
    const endMs = Date.parse(req.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { error: "mock-error" };
    }
    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 50;

    // mem0 doesn't expose a time-range query. Enumerate via getAll() and
    // filter in-process on the local `records` map (which carries
    // created_at from add_memory_note).
    await this.client.getAll({ userId: this.userId, limit: 1000 });
    const hits: TimeRangeHit[] = [];
    for (const [ext, rec] of this.records) {
      if (this.tombstones.has(ext)) continue;
      const t = Date.parse(rec.created_at);
      if (t >= startMs && t <= endMs) {
        hits.push({ id: ext, created_at: rec.created_at, tags: rec.tags });
      }
    }
    hits.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const truncated = hits.length > limit;
    return { hits: hits.slice(0, limit), truncated };
  }

  async addMemoryNote(
    req: AddMemoryNoteRequest
  ): Promise<
    AddMemoryNoteResponse | MemoryDeletionForbiddenResponse | MockErrorResponse
  > {
    this.callCount++;
    if (this.errorForTool === "add_memory_note") return { error: "mock-error" };

    // §10.7.2 + §8.1 L-58 — reject sensitive-personal BEFORE any mem0
    // call so the sensitive input is never embedded/summarized/indexed.
    if (req.data_class === "sensitive-personal") {
      return { error: "MemoryDeletionForbidden", reason: "sensitive-class-forbidden" };
    }

    // Idempotent repeat with caller-supplied note_id → original created_at.
    if (typeof req.note_id === "string" && req.note_id.length > 0) {
      const existing = this.records.get(req.note_id);
      if (existing) return { note_id: req.note_id, created_at: existing.created_at };
    }

    const createdAt = this.now().toISOString();
    const importance = typeof req.importance === "number" ? req.importance : 0.5;
    const tags = Array.isArray(req.tags) ? req.tags : [];
    try {
      const res = await this.client.add(req.summary, {
        userId: this.userId,
        metadata: {
          data_class: req.data_class,
          session_id: req.session_id,
          created_at: createdAt,
          tags,
          importance,
          external_id: req.note_id ?? null
        },
        infer: false
      });
      const mem0Id = res.results?.[0]?.id ?? randomBytes(8).toString("hex");
      const ext = req.note_id ?? this.toExternal(mem0Id);
      this.memByExternal.set(ext, mem0Id);
      this.externalByMem.set(mem0Id, ext);
      this.records.set(ext, {
        summary: req.summary,
        data_class: req.data_class,
        session_id: req.session_id,
        created_at: createdAt,
        tags,
        importance
      });
      return { note_id: ext, created_at: createdAt };
    } catch (err) {
      return { error: "mock-error", detail: String(err) } as MockErrorResponse & {
        detail: string;
      };
    }
  }

  async readMemoryNote(
    req: ReadMemoryNoteRequest
  ): Promise<ReadMemoryNoteResponse | MemoryNotFoundResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "read_memory_note") return { error: "mock-error" };
    if (typeof req.id !== "string" || req.id.length === 0) {
      return { error: "MemoryNotFound", id: req.id ?? "" };
    }
    if (this.tombstones.has(req.id)) return { error: "MemoryNotFound", id: req.id };

    const rec = this.records.get(req.id);
    if (!rec) return { error: "MemoryNotFound", id: req.id };
    return {
      id: req.id,
      note: rec.summary,
      tags: rec.tags,
      importance: rec.importance,
      created_at: rec.created_at,
      graph_edges: []
    };
  }

  async consolidateMemories(
    req: ConsolidateMemoriesRequest
  ): Promise<ConsolidateMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "consolidate_memories") return { error: "mock-error" };
    void req.consolidation_threshold;
    // mem0 auto-consolidates via its history store; surface the current
    // note count as "consolidated" from this call's perspective.
    return {
      consolidated_count: this.records.size - this.tombstones.size,
      pending_count: 0
    };
  }

  async deleteMemoryNote(
    req: DeleteMemoryNoteRequest
  ): Promise<DeleteMemoryNoteResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "delete_memory_note") return { error: "mock-error" };

    const existingTomb = this.tombstones.get(req.id);
    if (existingTomb) {
      return {
        deleted: true,
        tombstone_id: existingTomb.tombstone_id,
        deleted_at: existingTomb.deleted_at
      };
    }
    const mem0Id = this.memByExternal.get(req.id);
    if (!mem0Id && !this.records.has(req.id)) {
      return { error: "mock-error" };
    }
    if (mem0Id) {
      try {
        await this.client.delete(mem0Id);
      } catch {
        // mem0 may already have lost the record; tombstone anyway.
      }
    }
    const ts = {
      tombstone_id: `tomb_${randomBytes(6).toString("hex")}`,
      deleted_at: this.now().toISOString(),
      reason: req.reason ?? ""
    };
    this.tombstones.set(req.id, ts);
    return { deleted: true, tombstone_id: ts.tombstone_id, deleted_at: ts.deleted_at };
  }

  /** Test helper — inspect the tombstone record for an id. */
  tombstoneFor(
    id: string
  ): { tombstone_id: string; deleted_at: string; reason: string } | undefined {
    return this.tombstones.get(id);
  }
}
