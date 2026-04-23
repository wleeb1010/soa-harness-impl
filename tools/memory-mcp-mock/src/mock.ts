/**
 * Memory MCP Mock — §8.1 tool protocol (expanded for L-38).
 *
 * Spec fixture: `test-vectors/memory-mcp-mock/README.md`
 *
 * Tools implemented (§8.1 — 6 canonical tools):
 *   - search_memories({query, limit, sharing_scope}) → {notes: [...]}
 *   - search_memories_by_time({start, end, limit?}) → {hits: [...], truncated}
 *   - add_memory_note({summary, data_class, session_id, note_id?}) → {note_id}
 *     (idempotent iff note_id is pre-specified per §8.1; otherwise mints a new id)
 *   - read_memory_note({id}) → {id, note, tags, importance, created_at, graph_edges}
 *     (MemoryNotFound on unknown id)
 *   - consolidate_memories({consolidation_threshold}) → {consolidated_count, pending_count}
 *   - delete_memory_note({id, reason}) → {deleted, tombstone_id, deleted_at}
 *     (idempotent on id per §8.1 line 566; tombstoned ids NEVER reappear
 *     in search_memories responses; repeat delete returns same
 *     tombstone_id + deleted_at)
 *
 * Env var controls:
 *   SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS=<n>
 *     After N successful calls, the next N+1 calls time out (no response
 *     within 5s). Reset on process restart. `0` = every call times out.
 *   SOA_MEMORY_MCP_MOCK_RETURN_ERROR=<tool_name>
 *     The named tool returns {"error": "mock-error"} instead of success.
 *     Omit for normal operation.
 *   SOA_MEMORY_MCP_MOCK_SEED=<path>
 *     Path to a corpus-seed.json file. When set, the mock loads the
 *     pinned 20-note corpus at startup for search_memories scoring.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** Per §8.1 request/response shapes. */
export interface SearchMemoriesRequest {
  query: string;
  limit?: number;
  sharing_scope?: "none" | "session" | "project" | "tenant";
}

export interface NoteHit {
  note_id: string;
  summary: string;
  data_class: "public" | "internal" | "confidential" | "personal";
  composite_score: number;
  weight_semantic?: number;
  weight_recency?: number;
  weight_graph_strength?: number;
}

export interface SearchMemoriesResponse {
  notes: NoteHit[];
}

export interface AddMemoryNoteRequest {
  summary: string;
  data_class: "public" | "internal" | "confidential" | "personal";
  session_id: string;
}

export interface AddMemoryNoteResponse {
  note_id: string;
}

/** §8.1 search_memories_by_time — RFC 3339 range query. */
export interface SearchMemoriesByTimeRequest {
  start: string;
  end: string;
  limit?: number;
}

export interface TimeRangeHit {
  id: string;
  created_at: string;
  tags: string[];
}

export interface SearchMemoriesByTimeResponse {
  hits: TimeRangeHit[];
  truncated: boolean;
}

/** §8.1 read_memory_note — fetch full body by id. */
export interface ReadMemoryNoteRequest {
  id: string;
}

export interface ReadMemoryNoteResponse {
  id: string;
  note: string;
  tags: string[];
  importance: number;
  created_at: string;
  graph_edges: string[];
}

export interface MemoryNotFoundResponse {
  error: "MemoryNotFound";
  id: string;
}

export interface ConsolidateMemoriesRequest {
  consolidation_threshold?: string;
}

export interface DeleteMemoryNoteRequest {
  id: string;
  reason?: string;
}

export interface DeleteMemoryNoteResponse {
  deleted: boolean;
  tombstone_id: string;
  deleted_at: string;
}

export interface Tombstone {
  id: string;
  tombstone_id: string;
  created_at: string;
  tags: string[];
  deleted_at: string;
  reason: string;
}

export interface ConsolidateMemoriesResponse {
  consolidated_count: number;
  pending_count: number;
}

export interface MockErrorResponse {
  error: string;
}

interface CorpusSeedEntry {
  note_id: string;
  summary: string;
  data_class: NoteHit["data_class"];
  recency_days_ago: number;
  graph_strength: number;
}

export interface MemoryMockOptions {
  /** Env-parsed N for TIMEOUT_AFTER_N_CALLS. -1 = no timeout injection. */
  timeoutAfterNCalls?: number;
  /** Env-parsed tool name that returns a mock-error response. */
  errorForTool?: string | null;
  /** Pre-loaded corpus (test-only shortcut; production loads from path). */
  seedCorpus?: CorpusSeedEntry[];
  /** Path to corpus-seed.json (for log visibility). */
  seedPath?: string;
}

export type ToolName =
  | "search_memories"
  | "search_memories_by_time"
  | "add_memory_note"
  | "read_memory_note"
  | "consolidate_memories"
  | "delete_memory_note";

/**
 * Core mock implementation separated from the HTTP transport so unit
 * tests can exercise the protocol without standing up a server.
 */
export class MemoryMcpMock {
  private readonly timeoutAfterNCalls: number;
  private readonly errorForTool: string | null;
  private readonly corpus: CorpusSeedEntry[];
  private callCount = 0;
  /**
   * Session-written notes — distinct from the seed corpus. search_memories
   * returns from the seed corpus only (deterministic scoring); add_memory_note
   * accumulates here so subsequent consolidate_memories can act on them.
   */
  private readonly writtenNotes: Array<{
    note_id: string;
    summary: string;
    data_class: NoteHit["data_class"];
    session_id: string;
  }> = [];
  /**
   * §8.1 idempotent tombstone store: keyed by the source note id so a
   * repeat delete_memory_note call returns the same tombstone_id +
   * deleted_at. Tombstones survive for the process lifetime (no TTL in
   * the mock — real implementations should retain per operator policy).
   */
  private readonly tombstones = new Map<string, Tombstone>();

  constructor(opts: MemoryMockOptions = {}) {
    this.timeoutAfterNCalls = opts.timeoutAfterNCalls ?? -1;
    this.errorForTool = opts.errorForTool ?? null;
    this.corpus = opts.seedCorpus ?? [];
  }

  /**
   * True when this call should time out (per SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS).
   * Callers handle the actual "no response within 5s" by awaiting a never-
   * resolving promise, or by throwing/abandoning the response.
   */
  shouldTimeout(): boolean {
    if (this.timeoutAfterNCalls < 0) return false;
    return this.callCount >= this.timeoutAfterNCalls;
  }

  /** Diagnostic — how many tool invocations have been processed this process lifetime. */
  invocationCount(): number {
    return this.callCount;
  }

  async searchMemories(
    req: SearchMemoriesRequest
  ): Promise<SearchMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories") return { error: "mock-error" };

    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 10;
    // Deterministic three-weight composite. Tests assert top-N based on the
    // pinned corpus-seed.json values so the scoring function MUST be stable
    // across platforms. Weights: semantic (naive substring match), recency
    // (inverse days), graph_strength (from the seed).
    const q = req.query.toLowerCase();
    // §8.1 — tombstoned ids MUST NOT appear in search responses.
    const liveCorpus = this.corpus.filter((e) => !this.tombstones.has(e.note_id));
    const scored = liveCorpus.map((entry) => {
      const semantic = substringScore(entry.summary.toLowerCase(), q);
      const recency = 1 / (1 + entry.recency_days_ago);
      const graph = entry.graph_strength;
      const composite = 0.5 * semantic + 0.25 * recency + 0.25 * graph;
      return {
        note_id: entry.note_id,
        summary: entry.summary,
        data_class: entry.data_class,
        weight_semantic: round3(semantic),
        weight_recency: round3(recency),
        weight_graph_strength: round3(graph),
        composite_score: round3(composite)
      };
    });
    scored.sort((a, b) => b.composite_score - a.composite_score);
    return { notes: scored.slice(0, limit) };
  }

  async addMemoryNote(req: AddMemoryNoteRequest): Promise<AddMemoryNoteResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "add_memory_note") return { error: "mock-error" };
    // §8.1: idempotent iff id is pre-specified; otherwise a new id is minted.
    // Test-surface extension to the original WriteMemoryRequest shape —
    // callers who omit note_id get the legacy mint-new behavior.
    const reqWithId = req as AddMemoryNoteRequest & { note_id?: string };
    if (typeof reqWithId.note_id === "string" && reqWithId.note_id.length > 0) {
      const existing = this.writtenNotes.find((n) => n.note_id === reqWithId.note_id);
      if (existing) return { note_id: existing.note_id };
      this.writtenNotes.push({
        note_id: reqWithId.note_id,
        summary: req.summary,
        data_class: req.data_class,
        session_id: req.session_id,
      });
      return { note_id: reqWithId.note_id };
    }
    const note_id = `mem_${randomBytes(6).toString("hex")}`;
    this.writtenNotes.push({
      note_id,
      summary: req.summary,
      data_class: req.data_class,
      session_id: req.session_id
    });
    return { note_id };
  }

  /**
   * §8.1 search_memories_by_time — RFC 3339 window query over the seed
   * corpus + any written notes that carry a time-convertible recency.
   * Mock semantics: the seed corpus's `recency_days_ago` is converted to
   * a synthetic `created_at` relative to a fixed epoch so the time-range
   * filter is deterministic across platforms. Written notes all bear
   * "now" as their created_at (mock is single-process; time advances
   * between writes monotonically).
   */
  async searchMemoriesByTime(
    req: SearchMemoriesByTimeRequest,
  ): Promise<SearchMemoriesByTimeResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "search_memories_by_time") return { error: "mock-error" };
    const startMs = Date.parse(req.start);
    const endMs = Date.parse(req.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { error: "mock-error" };
    }
    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 100) : 50;

    const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
    const hits: TimeRangeHit[] = [];
    for (const entry of this.corpus) {
      if (this.tombstones.has(entry.note_id)) continue;
      const createdMs = EPOCH - entry.recency_days_ago * 86400_000;
      if (createdMs >= startMs && createdMs <= endMs) {
        hits.push({
          id: entry.note_id,
          created_at: new Date(createdMs).toISOString(),
          tags: [],
        });
      }
    }
    hits.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const truncated = hits.length > limit;
    return { hits: hits.slice(0, limit), truncated };
  }

  /**
   * §8.1 read_memory_note — fetch the full note body + metadata by id.
   * Unknown id → MemoryNotFound per §8.1. Corpus-sourced notes return
   * synthetic metadata so the response is well-formed.
   */
  async readMemoryNote(
    req: ReadMemoryNoteRequest,
  ): Promise<ReadMemoryNoteResponse | MemoryNotFoundResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "read_memory_note") return { error: "mock-error" };
    if (typeof req.id !== "string" || req.id.length === 0) {
      return { error: "MemoryNotFound", id: req.id ?? "" };
    }

    const corpusHit = this.corpus.find((n) => n.note_id === req.id);
    if (corpusHit) {
      const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
      const createdMs = EPOCH - corpusHit.recency_days_ago * 86400_000;
      return {
        id: corpusHit.note_id,
        note: corpusHit.summary,
        tags: [],
        importance: corpusHit.graph_strength,
        created_at: new Date(createdMs).toISOString(),
        graph_edges: [],
      };
    }

    const writtenHit = this.writtenNotes.find((n) => n.note_id === req.id);
    if (writtenHit) {
      return {
        id: writtenHit.note_id,
        note: writtenHit.summary,
        tags: [],
        importance: 0,
        created_at: new Date().toISOString(),
        graph_edges: [],
      };
    }

    return { error: "MemoryNotFound", id: req.id };
  }

  async consolidateMemories(
    req: ConsolidateMemoriesRequest
  ): Promise<ConsolidateMemoriesResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "consolidate_memories") return { error: "mock-error" };
    // Mock semantics: "consolidate" counts the written notes and clears
    // them. consolidation_threshold is accepted for protocol completeness
    // but doesn't affect the mock's count.
    void req.consolidation_threshold;
    const consolidated = this.writtenNotes.length;
    this.writtenNotes.length = 0;
    return { consolidated_count: consolidated, pending_count: 0 };
  }

  /**
   * §8.1 delete_memory_note — idempotent on `id` (line 566). Returns
   * the same tombstone_id + deleted_at on every repeat call. The
   * deleted note never reappears in search_memories after this call.
   *
   * Error taxonomy (§8.1 → §24):
   *   MemoryNotFound — id is unknown (not in corpus, writtenNotes, or
   *                    tombstones).
   *   MemoryDeletionForbidden — the id exists but is protected from
   *                    deletion (mock: all deletes are permitted, so
   *                    this branch is unreachable in the default
   *                    config; error-injection via
   *                    SOA_MEMORY_MCP_MOCK_RETURN_ERROR=delete_memory_note
   *                    surfaces the generic mock-error).
   */
  async deleteMemoryNote(
    req: DeleteMemoryNoteRequest
  ): Promise<DeleteMemoryNoteResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "delete_memory_note") return { error: "mock-error" };

    // Idempotency: if already tombstoned, return the prior record
    // verbatim. Identical tombstone_id + deleted_at across retries.
    const existing = this.tombstones.get(req.id);
    if (existing) {
      return {
        deleted: true,
        tombstone_id: existing.tombstone_id,
        deleted_at: existing.deleted_at
      };
    }

    // Resolve the source note — corpus first, then writtenNotes.
    const corpusHit = this.corpus.find((n) => n.note_id === req.id);
    const writtenHit = this.writtenNotes.find((n) => n.note_id === req.id);
    if (!corpusHit && !writtenHit) {
      return { error: "mock-error" }; // MemoryNotFound sentinel in the mock
    }

    const now = new Date().toISOString();
    const tombstone_id = `tomb_${randomBytes(6).toString("hex")}`;
    const created_at = corpusHit
      ? // seed entries don't carry created_at; synthesize a deterministic
        // boot-time stamp so the tombstone record is well-formed.
        new Date(0).toISOString()
      : now;
    const tombstone: Tombstone = {
      id: req.id,
      tombstone_id,
      created_at,
      tags: [], // mock doesn't carry tags; retained as empty array
      deleted_at: now,
      reason: typeof req.reason === "string" ? req.reason : ""
    };
    this.tombstones.set(req.id, tombstone);

    // Remove from writtenNotes in place — subsequent consolidates
    // won't see it. Corpus entries stay in memory (source-of-truth for
    // seed determinism) but are filtered at search time.
    if (writtenHit) {
      const idx = this.writtenNotes.findIndex((n) => n.note_id === req.id);
      if (idx >= 0) this.writtenNotes.splice(idx, 1);
    }

    return { deleted: true, tombstone_id, deleted_at: now };
  }

  /** Test-only: read the tombstone record for an id. */
  tombstoneFor(id: string): Tombstone | undefined {
    return this.tombstones.get(id);
  }
}

/** Naive substring-overlap score normalized to [0, 1]. Stable across platforms. */
function substringScore(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  const tokens = needle.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) hits++;
  }
  return hits / tokens.length;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Parse env vars into MemoryMockOptions. Exposed so bin + tests agree. */
export function parseMockEnv(env: NodeJS.ProcessEnv): MemoryMockOptions {
  const opts: MemoryMockOptions = {};
  const timeoutRaw = env["SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS"];
  if (timeoutRaw !== undefined) {
    const n = Number.parseInt(timeoutRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS must be a non-negative integer, got "${timeoutRaw}"`
      );
    }
    opts.timeoutAfterNCalls = n;
  }
  const errRaw = env["SOA_MEMORY_MCP_MOCK_RETURN_ERROR"];
  if (typeof errRaw === "string" && errRaw.length > 0) {
    if (
      ![
        "search_memories",
        "search_memories_by_time",
        "add_memory_note",
        "read_memory_note",
        "consolidate_memories",
        "delete_memory_note",
      ].includes(errRaw)
    ) {
      throw new Error(
        `SOA_MEMORY_MCP_MOCK_RETURN_ERROR must name a tool (search_memories | search_memories_by_time | add_memory_note | read_memory_note | consolidate_memories | delete_memory_note), got "${errRaw}"`
      );
    }
    opts.errorForTool = errRaw;
  }
  const seedPath = env["SOA_MEMORY_MCP_MOCK_SEED"];
  if (typeof seedPath === "string" && seedPath.length > 0) {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as { notes?: CorpusSeedEntry[] };
    if (!Array.isArray(parsed.notes)) {
      throw new Error(`${seedPath}: missing "notes" array`);
    }
    opts.seedCorpus = parsed.notes;
    opts.seedPath = seedPath;
  }
  return opts;
}
