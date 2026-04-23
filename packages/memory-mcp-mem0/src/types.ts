/**
 * §8.1 request/response shapes (post-L-58 canonical).
 * Field-for-field identical to `@soa-harness/memory-mcp-sqlite` so a
 * Runner configured with either backend accepts traffic identically.
 */

export type DataClass =
  | "public"
  | "internal"
  | "confidential"
  | "personal"
  | "sensitive-personal";

export type SharingScope = "none" | "session" | "project" | "tenant";

export interface SearchMemoriesRequest {
  query: string;
  limit?: number;
  sharing_scope?: SharingScope;
}

export interface NoteHit {
  note_id: string;
  summary: string;
  data_class: DataClass;
  composite_score: number;
  weight_semantic?: number;
  weight_recency?: number;
  weight_graph_strength?: number;
}

export interface SearchMemoriesResponse {
  hits: NoteHit[];
}

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

export interface AddMemoryNoteRequest {
  summary: string;
  data_class: DataClass;
  session_id: string;
  note_id?: string;
  tags?: string[];
  importance?: number;
}

export interface AddMemoryNoteResponse {
  note_id: string;
  created_at: string;
}

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

/**
 * §10.7.2 + §8.1 L-58: reject sensitive-personal data_class BEFORE any
 * bytes reach the LLM. Returned from add_memory_note when the request's
 * data_class violates the sensitive-class allowlist.
 */
export interface MemoryDeletionForbiddenResponse {
  error: "MemoryDeletionForbidden";
  reason: "sensitive-class-forbidden";
}

export interface ConsolidateMemoriesRequest {
  consolidation_threshold?: string;
}

export interface ConsolidateMemoriesResponse {
  consolidated_count: number;
  pending_count: number;
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

export interface MockErrorResponse {
  error: string;
}

export type ToolName =
  | "search_memories"
  | "search_memories_by_time"
  | "add_memory_note"
  | "read_memory_note"
  | "consolidate_memories"
  | "delete_memory_note";

export const TOOL_NAMES: readonly ToolName[] = [
  "search_memories",
  "search_memories_by_time",
  "add_memory_note",
  "read_memory_note",
  "consolidate_memories",
  "delete_memory_note"
] as const;

export interface CorpusSeedEntry {
  note_id: string;
  summary: string;
  data_class: DataClass;
  recency_days_ago: number;
  graph_strength: number;
}
