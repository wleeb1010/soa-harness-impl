/**
 * §8.6 in-process Memory state store.
 *
 * Tracks per-session memory observability state for the /memory/state
 * endpoint. Populated via:
 *   - `initFor(session_id)` at §12.6 session bootstrap with defaults
 *     (empty in_context, consolidation.last_run_at = now, sharing_policy
 *     from Agent Card's memory.sharing_policy default).
 *   - `recordLoad()` when the Runner executes a Memory MCP search_memories
 *     call and selects notes into context per §8.2.
 *   - `recordConsolidation()` when §8.4 consolidation runs.
 *   - `setAvailableCount()` when the Runner knows how many notes are
 *     reachable by the session's sharing_policy scope.
 *
 * Reads via `get()` are not-a-side-effect; the /memory/state endpoint
 * MUST NOT trigger consolidation or advance aging clocks.
 */

import type { Clock } from "../clock/index.js";
import { MemoryDeletionForbidden } from "../privacy/errors.js";

export type SharingPolicy = "none" | "session" | "project" | "tenant";
/**
 * §10.7 data-class closed enum. Added `sensitive-personal` per SV-PRIV-02
 * — MUST NOT be persisted to memory in any form; consolidation attempts
 * emit MemoryDeletionForbidden(reason=sensitive-class-forbidden).
 */
export type DataClass =
  | "public"
  | "internal"
  | "confidential"
  | "personal"
  | "sensitive-personal";

export interface MemoryInContextNote {
  note_id: string;
  summary: string;
  data_class: DataClass;
  weight_semantic?: number;
  weight_recency?: number;
  weight_graph_strength?: number;
  composite_score: number;
  loaded_at: string; // RFC 3339
}

export interface MemoryConsolidationState {
  last_run_at: string;
  next_due_at?: string;
  pending_notes: number;
}

export interface MemoryAgingConfig {
  temporal_indexing?: boolean;
  consolidation_threshold?: string;
  max_in_context_tokens?: number;
  [extra: string]: unknown;
}

export interface MemoryState {
  session_id: string;
  sharing_policy: SharingPolicy;
  in_context_notes: MemoryInContextNote[];
  available_notes_count: number;
  consolidation: MemoryConsolidationState;
  aging: MemoryAgingConfig;
}

export interface MemoryStateInit {
  session_id: string;
  sharing_policy?: SharingPolicy;
  aging?: MemoryAgingConfig;
  available_notes_count?: number;
}

export interface MemoryStateStoreOptions {
  clock: Clock;
  /** Default sharing_policy when a session doesn't specify one. §8.5 default is `session`. */
  defaultSharingPolicy?: SharingPolicy;
  /** Default aging config sourced from the Agent Card. */
  defaultAging?: MemoryAgingConfig;
}

export class InMemoryMemoryStateStore {
  private readonly byId = new Map<string, MemoryState>();
  private readonly clock: Clock;
  private readonly defaultSharingPolicy: SharingPolicy;
  private readonly defaultAging: MemoryAgingConfig;

  constructor(opts: MemoryStateStoreOptions) {
    this.clock = opts.clock;
    this.defaultSharingPolicy = opts.defaultSharingPolicy ?? "session";
    this.defaultAging = opts.defaultAging ?? {};
  }

  /** Initialize state for a newly-bootstrapped session. Idempotent. */
  initFor(params: MemoryStateInit): MemoryState {
    const existing = this.byId.get(params.session_id);
    if (existing) return existing;
    const nowIso = this.clock().toISOString();
    const state: MemoryState = {
      session_id: params.session_id,
      sharing_policy: params.sharing_policy ?? this.defaultSharingPolicy,
      in_context_notes: [],
      available_notes_count: params.available_notes_count ?? 0,
      consolidation: {
        last_run_at: nowIso,
        pending_notes: 0
      },
      aging: { ...this.defaultAging, ...(params.aging ?? {}) }
    };
    this.byId.set(params.session_id, state);
    return state;
  }

  /** True when state has been initialized for `session_id`. */
  has(session_id: string): boolean {
    return this.byId.has(session_id);
  }

  /**
   * Returns a defensive copy of the state so callers cannot mutate
   * the internal record through their copy — not-a-side-effect per §8.6.
   */
  get(session_id: string): MemoryState | undefined {
    const s = this.byId.get(session_id);
    if (!s) return undefined;
    return {
      ...s,
      in_context_notes: s.in_context_notes.map((n) => ({ ...n })),
      consolidation: { ...s.consolidation },
      aging: { ...s.aging }
    };
  }

  /**
   * Record a §8.2 in-context load — replaces the session's in_context
   * with the new set. Each note's `loaded_at` stamps to the current clock.
   * `available_notes_count` tracks the total visible to this session's
   * sharing_policy scope; caller updates it from the MCP search result.
   */
  recordLoad(
    session_id: string,
    notes: Omit<MemoryInContextNote, "loaded_at">[],
    availableNotesCount: number
  ): void {
    const state = this.byId.get(session_id);
    if (!state) return;
    // §10.7 SV-PRIV-02 — sensitive-personal MUST NOT be persisted to
    // memory in any form. Any attempt to load such an entry into the
    // in-context set surfaces MemoryDeletionForbidden so the caller
    // can abort the consolidation or drop the slice before persist.
    for (const n of notes) {
      if (n.data_class === "sensitive-personal") {
        throw new MemoryDeletionForbidden({
          reason: "sensitive-class-forbidden",
          note_id: n.note_id,
          session_id,
          message:
            `note ${n.note_id} tagged data_class=sensitive-personal — ` +
            "§10.7 #2 forbids persistence; MUST drop or re-tag before memory write"
        });
      }
    }
    const loadedAt = this.clock().toISOString();
    state.in_context_notes = notes.map((n) => ({ ...n, loaded_at: loadedAt }));
    state.available_notes_count = availableNotesCount;
  }

  /**
   * §10.7 SV-PRIV-02 pre-consolidation guard. Call BEFORE dispatching
   * `consolidate_memories` — if the pending slice contains any
   * sensitive-personal entry, throw so the scheduler emits the
   * MemoryDeletionForbidden system-log record and skips the run.
   */
  guardSensitivePersonal(notes: readonly { note_id: string; data_class: DataClass }[]): void {
    for (const n of notes) {
      if (n.data_class === "sensitive-personal") {
        throw new MemoryDeletionForbidden({
          reason: "sensitive-class-forbidden",
          note_id: n.note_id,
          message:
            `note ${n.note_id} tagged data_class=sensitive-personal — ` +
            "§10.7 #2 forbids consolidation of this record"
        });
      }
    }
  }

  /** Record a §8.4 consolidation pass. */
  recordConsolidation(
    session_id: string,
    consolidatedCount: number,
    pendingCount: number,
    nextDueAt?: Date
  ): void {
    const state = this.byId.get(session_id);
    if (!state) return;
    state.consolidation = {
      last_run_at: this.clock().toISOString(),
      pending_notes: pendingCount,
      ...(nextDueAt ? { next_due_at: nextDueAt.toISOString() } : {})
    };
    // consolidatedCount is observable via the trailing-pending delta —
    // we don't persist it separately here.
    void consolidatedCount;
  }

  /** Remove state for a session (e.g., post-termination cleanup). */
  remove(session_id: string): void {
    this.byId.delete(session_id);
  }
}
