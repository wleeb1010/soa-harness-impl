/**
 * Memory MCP Mock — §8.1 three-tool protocol.
 *
 * Spec fixture: `test-vectors/memory-mcp-mock/README.md`
 *
 * Tools implemented:
 *   - search_memories({query, limit, sharing_scope}) → {notes: [...]}
 *   - write_memory({summary, data_class, session_id}) → {note_id}
 *   - consolidate_memories({consolidation_threshold}) → {consolidated_count, pending_count}
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

export interface WriteMemoryRequest {
  summary: string;
  data_class: "public" | "internal" | "confidential" | "personal";
  session_id: string;
}

export interface WriteMemoryResponse {
  note_id: string;
}

export interface ConsolidateMemoriesRequest {
  consolidation_threshold?: string;
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

export type ToolName = "search_memories" | "write_memory" | "consolidate_memories";

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
   * returns from the seed corpus only (deterministic scoring); write_memory
   * accumulates here so subsequent consolidate_memories can act on them.
   */
  private readonly writtenNotes: Array<{
    note_id: string;
    summary: string;
    data_class: NoteHit["data_class"];
    session_id: string;
  }> = [];

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
    const scored = this.corpus.map((entry) => {
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

  async writeMemory(req: WriteMemoryRequest): Promise<WriteMemoryResponse | MockErrorResponse> {
    this.callCount++;
    if (this.errorForTool === "write_memory") return { error: "mock-error" };
    const note_id = `mem_${randomBytes(6).toString("hex")}`;
    this.writtenNotes.push({
      note_id,
      summary: req.summary,
      data_class: req.data_class,
      session_id: req.session_id
    });
    return { note_id };
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
    if (!["search_memories", "write_memory", "consolidate_memories"].includes(errRaw)) {
      throw new Error(
        `SOA_MEMORY_MCP_MOCK_RETURN_ERROR must name a tool (search_memories | write_memory | consolidate_memories), got "${errRaw}"`
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
