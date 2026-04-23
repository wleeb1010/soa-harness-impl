/**
 * SQLite-backed implementation of the §8.1 six-tool Memory MCP
 * protocol. Persistence in a single `better-sqlite3` database file;
 * tombstones stored alongside notes for crash-safe idempotent delete.
 *
 * Schema:
 *   notes          — user-written + seed-imported notes (id, summary,
 *                    data_class, session_id, created_at, recency_days_ago,
 *                    graph_strength, consolidated)
 *   tags           — (note_id, tag) many-to-many (placeholder; wire via
 *                    add_memory_note metadata in a future rc once the
 *                    spec formalizes it — today just round-tripped as [])
 *   graph_edges    — (note_id, target_note_id, relation) for read_memory_note's
 *                    graph_edges field (placeholder; today returns []
 *                    until §8.2 graph-linking spec lands)
 *   tombstones     — (note_id PRIMARY KEY, tombstone_id, created_at,
 *                    deleted_at, reason) — §8.1 idempotent delete contract.
 *
 * The backend is framework-agnostic; `server.ts` wires it to Fastify.
 */

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type {
  AddMemoryNoteRequest,
  AddMemoryNoteResponse,
  ConsolidateMemoriesRequest,
  ConsolidateMemoriesResponse,
  CorpusSeedEntry,
  DataClass,
  DeleteMemoryNoteRequest,
  DeleteMemoryNoteResponse,
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
import { NaiveScorer, type Scorer } from "./embeddings.js";

const EPOCH_MS = new Date("2026-01-01T00:00:00Z").getTime();

export interface SqliteMemoryBackendOptions {
  dbPath?: string;
  timeoutAfterNCalls?: number;
  errorForTool?: ToolName | null;
  seedCorpus?: CorpusSeedEntry[];
  scorer?: Scorer;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => Date;
}

export class SqliteMemoryBackend {
  private readonly db: DB;
  private readonly timeoutAfterNCalls: number;
  private readonly errorForTool: ToolName | null;
  private readonly scorer: Scorer;
  private readonly now: () => Date;
  private callCount = 0;

  constructor(opts: SqliteMemoryBackendOptions = {}) {
    this.db = new Database(opts.dbPath ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.timeoutAfterNCalls = opts.timeoutAfterNCalls ?? -1;
    this.errorForTool = opts.errorForTool ?? null;
    this.scorer = opts.scorer ?? new NaiveScorer();
    this.now = opts.now ?? (() => new Date());
    this.migrate();
    if (opts.seedCorpus) this.loadSeed(opts.seedCorpus);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        note_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        data_class TEXT NOT NULL CHECK (data_class IN ('public','internal','confidential','personal')),
        session_id TEXT,
        created_at TEXT NOT NULL,
        recency_days_ago REAL NOT NULL DEFAULT 0,
        graph_strength REAL NOT NULL DEFAULT 0,
        consolidated INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK (source IN ('seed','written'))
      );
      CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);

      CREATE TABLE IF NOT EXISTS tags (
        note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (note_id, tag)
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        target_note_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (note_id, target_note_id, relation)
      );

      CREATE TABLE IF NOT EXISTS tombstones (
        note_id TEXT PRIMARY KEY,
        tombstone_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  private loadSeed(seed: CorpusSeedEntry[]): void {
    const existing = this.db.prepare("SELECT COUNT(*) AS c FROM notes WHERE source = 'seed'").get() as { c: number };
    if (existing.c > 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO notes (note_id, summary, data_class, session_id, created_at, recency_days_ago, graph_strength, consolidated, source)
       VALUES (@note_id, @summary, @data_class, NULL, @created_at, @recency_days_ago, @graph_strength, 1, 'seed')`
    );
    const insertMany = this.db.transaction((entries: CorpusSeedEntry[]) => {
      for (const e of entries) {
        const createdMs = EPOCH_MS - e.recency_days_ago * 86400_000;
        insert.run({
          note_id: e.note_id,
          summary: e.summary,
          data_class: e.data_class,
          created_at: new Date(createdMs).toISOString(),
          recency_days_ago: e.recency_days_ago,
          graph_strength: e.graph_strength
        });
      }
    });
    insertMany(seed);
  }

  shouldTimeout(): boolean {
    if (this.timeoutAfterNCalls < 0) return false;
    return this.callCount >= this.timeoutAfterNCalls;
  }

  invocationCount(): number {
    return this.callCount;
  }

  close(): void {
    this.db.close();
  }

  async searchMemories(
    req: SearchMemoriesRequest
  ): Promise<SearchMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories") return { error: "mock-error" };

    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 10;
    const rows = this.db
      .prepare(
        `SELECT n.note_id, n.summary, n.data_class, n.recency_days_ago, n.graph_strength
           FROM notes n
           LEFT JOIN tombstones t ON t.note_id = n.note_id
           WHERE t.note_id IS NULL`
      )
      .all() as Array<{
        note_id: string;
        summary: string;
        data_class: DataClass;
        recency_days_ago: number;
        graph_strength: number;
      }>;

    const scored = await this.scorer.score(
      req.query ?? "",
      rows.map((r) => ({
        note_id: r.note_id,
        summary: r.summary,
        recency_days_ago: r.recency_days_ago,
        graph_strength: r.graph_strength
      }))
    );
    const byId = new Map(rows.map((r) => [r.note_id, r]));
    const hits: NoteHit[] = [];
    for (const s of scored) {
      const r = byId.get(s.note_id);
      if (!r) continue;
      hits.push({
        note_id: s.note_id,
        summary: r.summary,
        data_class: r.data_class,
        composite_score: s.composite_score,
        weight_semantic: s.weight_semantic,
        weight_recency: s.weight_recency,
        weight_graph_strength: s.weight_graph_strength
      });
    }
    hits.sort((a, b) => b.composite_score - a.composite_score);
    return { hits: hits.slice(0, limit) };
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

    const rows = this.db
      .prepare(
        `SELECT n.note_id, n.created_at
           FROM notes n
           LEFT JOIN tombstones t ON t.note_id = n.note_id
           WHERE t.note_id IS NULL
             AND n.created_at >= @start AND n.created_at <= @end
           ORDER BY n.created_at ASC`
      )
      .all({ start: req.start, end: req.end }) as Array<{
        note_id: string;
        created_at: string;
      }>;

    const hits: TimeRangeHit[] = rows.map((r) => ({
      id: r.note_id,
      created_at: r.created_at,
      tags: this.tagsFor(r.note_id)
    }));
    const truncated = hits.length > limit;
    return { hits: hits.slice(0, limit), truncated };
  }

  async addMemoryNote(
    req: AddMemoryNoteRequest
  ): Promise<AddMemoryNoteResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "add_memory_note") return { error: "mock-error" };

    if (typeof req.note_id === "string" && req.note_id.length > 0) {
      const existing = this.db
        .prepare("SELECT note_id, created_at FROM notes WHERE note_id = ?")
        .get(req.note_id) as { note_id: string; created_at: string } | undefined;
      if (existing) return { note_id: existing.note_id, created_at: existing.created_at };
      const createdAt = this.insertWritten(req.note_id, req);
      return { note_id: req.note_id, created_at: createdAt };
    }
    const noteId = `mem_${randomBytes(6).toString("hex")}`;
    const createdAt = this.insertWritten(noteId, req);
    return { note_id: noteId, created_at: createdAt };
  }

  private insertWritten(noteId: string, req: AddMemoryNoteRequest): string {
    const createdAt = this.now().toISOString();
    const importance = typeof req.importance === "number" ? req.importance : 0.5;
    this.db
      .prepare(
        `INSERT INTO notes (note_id, summary, data_class, session_id, created_at, recency_days_ago, graph_strength, consolidated, source)
         VALUES (@note_id, @summary, @data_class, @session_id, @created_at, 0, @importance, 0, 'written')`
      )
      .run({
        note_id: noteId,
        summary: req.summary,
        data_class: req.data_class,
        session_id: req.session_id,
        created_at: createdAt,
        importance
      });
    if (Array.isArray(req.tags) && req.tags.length > 0) {
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)");
      for (const tag of req.tags) insertTag.run(noteId, tag);
    }
    return createdAt;
  }

  async readMemoryNote(
    req: ReadMemoryNoteRequest
  ): Promise<ReadMemoryNoteResponse | MemoryNotFoundResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "read_memory_note") return { error: "mock-error" };
    if (typeof req.id !== "string" || req.id.length === 0) {
      return { error: "MemoryNotFound", id: req.id ?? "" };
    }
    if (this.isTombstoned(req.id)) return { error: "MemoryNotFound", id: req.id };

    const row = this.db
      .prepare("SELECT note_id, summary, created_at, graph_strength FROM notes WHERE note_id = ?")
      .get(req.id) as
      | { note_id: string; summary: string; created_at: string; graph_strength: number }
      | undefined;
    if (!row) return { error: "MemoryNotFound", id: req.id };

    return {
      id: row.note_id,
      note: row.summary,
      tags: this.tagsFor(row.note_id),
      importance: row.graph_strength,
      created_at: row.created_at,
      graph_edges: this.graphEdgesFor(row.note_id)
    };
  }

  async consolidateMemories(
    req: ConsolidateMemoriesRequest
  ): Promise<ConsolidateMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "consolidate_memories") return { error: "mock-error" };
    void req.consolidation_threshold;
    const info = this.db
      .prepare("UPDATE notes SET consolidated = 1 WHERE source = 'written' AND consolidated = 0")
      .run();
    return {
      consolidated_count: info.changes,
      pending_count: 0
    };
  }

  async deleteMemoryNote(
    req: DeleteMemoryNoteRequest
  ): Promise<DeleteMemoryNoteResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "delete_memory_note") return { error: "mock-error" };

    const existingTomb = this.db
      .prepare("SELECT tombstone_id, deleted_at FROM tombstones WHERE note_id = ?")
      .get(req.id) as { tombstone_id: string; deleted_at: string } | undefined;
    if (existingTomb) {
      return {
        deleted: true,
        tombstone_id: existingTomb.tombstone_id,
        deleted_at: existingTomb.deleted_at
      };
    }

    const sourceNote = this.db
      .prepare("SELECT note_id, created_at FROM notes WHERE note_id = ?")
      .get(req.id) as { note_id: string; created_at: string } | undefined;
    if (!sourceNote) return { error: "mock-error" };

    const tombstoneId = `tomb_${randomBytes(6).toString("hex")}`;
    const deletedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO tombstones (note_id, tombstone_id, created_at, deleted_at, reason)
         VALUES (@note_id, @tombstone_id, @created_at, @deleted_at, @reason)`
      )
      .run({
        note_id: req.id,
        tombstone_id: tombstoneId,
        created_at: sourceNote.created_at,
        deleted_at: deletedAt,
        reason: req.reason ?? ""
      });
    return { deleted: true, tombstone_id: tombstoneId, deleted_at: deletedAt };
  }

  private isTombstoned(id: string): boolean {
    const r = this.db.prepare("SELECT 1 FROM tombstones WHERE note_id = ?").get(id);
    return r !== undefined;
  }

  private tagsFor(noteId: string): string[] {
    const rows = this.db.prepare("SELECT tag FROM tags WHERE note_id = ?").all(noteId) as Array<{
      tag: string;
    }>;
    return rows.map((r) => r.tag);
  }

  private graphEdgesFor(noteId: string): string[] {
    const rows = this.db
      .prepare("SELECT target_note_id FROM graph_edges WHERE note_id = ?")
      .all(noteId) as Array<{ target_note_id: string }>;
    return rows.map((r) => r.target_note_id);
  }

  /** Test helper — read a tombstone record by source id. */
  tombstoneFor(id: string): { tombstone_id: string; deleted_at: string; reason: string } | undefined {
    return this.db
      .prepare("SELECT tombstone_id, deleted_at, reason FROM tombstones WHERE note_id = ?")
      .get(id) as { tombstone_id: string; deleted_at: string; reason: string } | undefined;
  }
}
