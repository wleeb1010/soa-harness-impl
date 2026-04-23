/**
 * §8.1 request/response shapes. Kept field-for-field identical to
 * `@soa-harness-tools/memory-mcp-mock` so the Runner's MemoryMcpClient
 * and the validator's SV-MEM probes treat this backend interchangeably.
 */

export type DataClass = "public" | "internal" | "confidential" | "personal";
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
}

export interface AddMemoryNoteResponse {
  note_id: string;
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
