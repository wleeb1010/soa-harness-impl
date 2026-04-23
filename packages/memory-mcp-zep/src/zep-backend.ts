/**
 * Zep-backed implementation of the §8.1 six-tool Memory MCP protocol.
 *
 * Pattern mirrors sqlite + mem0: backend is framework-agnostic; takes
 * an injected `ZepLikeCollection` so unit tests can run without Zep +
 * Postgres. Production wiring goes through `zep-client-factory.ts`.
 *
 * L-58 additions over the Gate 4 feasibility shim (05e27b1):
 *   - Sensitive-personal pre-filter on add_memory_note — reject before
 *     any bytes reach Zep (§10.7.2 + §8.1 canonical errata).
 *   - add_memory_note returns {note_id, created_at}; idempotent repeat
 *     returns the original created_at.
 *   - Optional tags[] + importance persisted to Zep document metadata.
 *
 * Zep SDK quirks carried forward from Gate 4:
 *   - `@getzep/zep-js@0.10.0`'s `getDocument(uuid)` builds a URL the
 *     server 404s on; this backend uses `getDocuments([uuid])` instead.
 *   - Collection names must be alphanum (checked at env-parse time,
 *     but the backend also exposes a guard).
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

export interface ZepDocument {
  uuid?: string;
  document_id?: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
  created_at?: Date | string;
}

/** Minimal Zep DocumentCollection surface the backend relies on. */
export interface ZepLikeCollection {
  addDocuments(docs: ZepDocument[]): Promise<string[]>;
  getDocuments(uuids: string[]): Promise<ZepDocument[]>;
  search(
    query: { text?: string; metadata?: Record<string, unknown> },
    limit?: number
  ): Promise<ZepDocument[]>;
  deleteDocument(uuid: string): Promise<void>;
}

export interface ZepBackendOptions {
  collection: ZepLikeCollection;
  timeoutAfterNCalls?: number;
  errorForTool?: ToolName | null;
  seedCorpus?: CorpusSeedEntry[];
  now?: () => Date;
}

interface NoteRecord {
  summary: string;
  data_class: DataClass;
  session_id: string;
  created_at: string;
  tags: string[];
  importance: number;
}

export class ZepBackend {
  private readonly collection: ZepLikeCollection;
  private readonly timeoutAfterNCalls: number;
  private readonly errorForTool: ToolName | null;
  private readonly now: () => Date;
  private callCount = 0;
  private readonly uuidByExt = new Map<string, string>();
  private readonly extByUuid = new Map<string, string>();
  private readonly tombstones = new Map<
    string,
    { tombstone_id: string; deleted_at: string; reason: string }
  >();
  private readonly records = new Map<string, NoteRecord>();

  constructor(opts: ZepBackendOptions) {
    this.collection = opts.collection;
    this.timeoutAfterNCalls = opts.timeoutAfterNCalls ?? -1;
    this.errorForTool = opts.errorForTool ?? null;
    this.now = opts.now ?? (() => new Date());
    if (opts.seedCorpus) void this.primeSeed(opts.seedCorpus);
  }

  private async primeSeed(seed: CorpusSeedEntry[]): Promise<void> {
    const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
    const docs: ZepDocument[] = [];
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
      docs.push({
        content: e.summary,
        document_id: e.note_id,
        metadata: {
          data_class: e.data_class,
          session_id: "",
          created_at: createdAt,
          mem_id: e.note_id,
          graph_strength: e.graph_strength
        }
      });
    }
    // Push seed notes into Zep so search_memories returns hits at
    // session-bootstrap time. Best-effort — if Zep rejects a duplicate
    // or is unreachable, the records map still serves read_memory_note.
    try {
      const uuids = await this.collection.addDocuments(docs);
      uuids.forEach((uuid, i) => {
        const ext = seed[i]!.note_id;
        this.uuidByExt.set(ext, uuid);
        this.extByUuid.set(uuid, ext);
      });
    } catch {
      // ignore — live in-process map still works for read_memory_note.
    }
  }

  shouldTimeout(): boolean {
    if (this.timeoutAfterNCalls < 0) return false;
    return this.callCount >= this.timeoutAfterNCalls;
  }

  invocationCount(): number {
    return this.callCount;
  }

  private toExternal(uuid: string): string {
    const cached = this.extByUuid.get(uuid);
    if (cached) return cached;
    const hex = createHash("sha256").update(uuid).digest("hex").slice(0, 12);
    const ext = `mem_${hex}`;
    this.extByUuid.set(uuid, ext);
    this.uuidByExt.set(ext, uuid);
    return ext;
  }

  async searchMemories(
    req: SearchMemoriesRequest
  ): Promise<SearchMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories") return { error: "mock-error" };
    if (!req.query || req.query.trim().length === 0) return { hits: [] };

    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 10;
    try {
      const results = await this.collection.search({ text: req.query }, limit);
      const hits: NoteHit[] = [];
      for (const d of results) {
        const ext = this.extByUuid.get(d.uuid ?? "") ?? this.toExternal(d.uuid ?? d.document_id ?? "");
        if (this.tombstones.has(ext)) continue;
        const rec = this.records.get(ext);
        hits.push({
          note_id: ext,
          summary: d.content,
          data_class: (d.metadata?.["data_class"] as DataClass) ?? rec?.data_class ?? "internal",
          composite_score: Math.max(0, Math.min(1, d.score ?? 0))
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

    // §10.7.2 + §8.1 L-58 — reject sensitive-personal BEFORE any Zep call.
    if (req.data_class === "sensitive-personal") {
      return { error: "MemoryDeletionForbidden", reason: "sensitive-class-forbidden" };
    }

    if (typeof req.note_id === "string" && req.note_id.length > 0) {
      const existing = this.records.get(req.note_id);
      if (existing) return { note_id: req.note_id, created_at: existing.created_at };
    }

    const createdAt = this.now().toISOString();
    const importance = typeof req.importance === "number" ? req.importance : 0.5;
    const tags = Array.isArray(req.tags) ? req.tags : [];
    const memId = req.note_id ?? `mem_${randomBytes(6).toString("hex")}`;

    try {
      const [uuid] = await this.collection.addDocuments([
        {
          content: req.summary,
          document_id: memId,
          metadata: {
            data_class: req.data_class,
            session_id: req.session_id,
            created_at: createdAt,
            tags,
            importance,
            mem_id: memId
          }
        }
      ]);
      if (uuid) {
        this.uuidByExt.set(memId, uuid);
        this.extByUuid.set(uuid, memId);
      }
      this.records.set(memId, {
        summary: req.summary,
        data_class: req.data_class,
        session_id: req.session_id,
        created_at: createdAt,
        tags,
        importance
      });
      return { note_id: memId, created_at: createdAt };
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

    const existing = this.tombstones.get(req.id);
    if (existing) {
      return {
        deleted: true,
        tombstone_id: existing.tombstone_id,
        deleted_at: existing.deleted_at
      };
    }
    const uuid = this.uuidByExt.get(req.id);
    if (!uuid && !this.records.has(req.id)) return { error: "mock-error" };
    if (uuid) {
      try {
        await this.collection.deleteDocument(uuid);
      } catch {
        // Zep may have lost the record; tombstone anyway.
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

  tombstoneFor(
    id: string
  ): { tombstone_id: string; deleted_at: string; reason: string } | undefined {
    return this.tombstones.get(id);
  }
}
