/**
 * §14.1 StreamEvent closed enum + in-process emitter.
 *
 * The 27-type enum is EXACTLY as pinned in §14.1 of the Core spec
 * (L-35 grew the set from 25 → 27 by adding PreToolUseOutcome +
 * PostToolUseOutcome, both trust_class=system Runner-chrome events
 * emitted by the §15 hook-outcome pipeline). Any other value at emit-side
 * raises StreamEventTypeInvalid BEFORE the event lands in the per-session
 * ring buffer — no unknown types can leak to /events/recent (§14.5) or
 * §14.3 SSE transport.
 *
 * Per-session monotonic sequence; unique event_id per event per process.
 *
 * Observability note: reads of the emitter are not-a-side-effect per §14.5.
 * snapshot() returns a defensive copy; callers CANNOT mutate the internal
 * buffer.
 */

import { randomBytes } from "node:crypto";
import type { Clock } from "../clock/index.js";

/** Exact §14.1 closed enum. Adding a value is a spec change. */
export const STREAM_EVENT_TYPES = [
  "SessionStart",
  "SessionEnd",
  "MessageStart",
  "MessageEnd",
  "ContentBlockStart",
  "ContentBlockDelta",
  "ContentBlockEnd",
  "ToolInputStart",
  "ToolInputDelta",
  "ToolInputEnd",
  "ToolResult",
  "ToolError",
  "PermissionPrompt",
  "PermissionDecision",
  "CompactionStart",
  "CompactionEnd",
  "MemoryLoad",
  "HandoffStart",
  "HandoffComplete",
  "HandoffFailed",
  "SelfImprovementStart",
  "SelfImprovementAccepted",
  "SelfImprovementRejected",
  "SelfImprovementOrphaned",
  "CrashEvent",
  "PreToolUseOutcome",
  "PostToolUseOutcome"
] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

const STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(STREAM_EVENT_TYPES);

/** True when `value` is one of the 27 canonical §14.1 types. Exposed for tests. */
export function isStreamEventType(value: unknown): value is StreamEventType {
  return typeof value === "string" && STREAM_EVENT_TYPE_SET.has(value);
}

/** Raised at emit-side when the type isn't in the §14.1 closed enum. */
export class StreamEventTypeInvalid extends Error {
  readonly attempted: string;
  constructor(type: string) {
    super(
      `StreamEvent.type "${type}" is not in the §14.1 closed 27-type enum; ` +
        `the emitter refuses to record it. Adding a value is a spec change.`
    );
    this.name = "StreamEventTypeInvalid";
    this.attempted = type;
  }
}

/** Shape of an emitted event returned to consumers (e.g., /events/recent). */
export interface EmittedEvent {
  event_id: string;
  sequence: number;
  type: StreamEventType;
  session_id: string;
  emitted_at: string;
  workflow_state_id?: string;
  payload: Record<string, unknown>;
}

export interface EmitParams {
  session_id: string;
  type: string;
  payload: Record<string, unknown>;
  workflow_state_id?: string;
}

export interface StreamEventEmitterOptions {
  clock: Clock;
  /** Optional hard cap on retained events per session (default 1000, FIFO eviction). */
  maxEventsPerSession?: number;
}

/**
 * In-process §14.1 emitter backing /events/recent (§14.5). Full §14.3 SSE
 * transport is M4 scope and would stream from this same buffer — the
 * emitter decouples "event produced" from "event transported".
 *
 * FIFO cap per session keeps the ring bounded so a long-lived session
 * doesn't grow the heap indefinitely. When the cap is hit, the oldest
 * events are evicted; `next_after` pagination semantics stay valid for
 * still-retained IDs.
 */
export class StreamEventEmitter {
  private readonly events = new Map<string, EmittedEvent[]>();
  private readonly sequences = new Map<string, number>();
  private readonly maxPerSession: number;

  constructor(private readonly opts: StreamEventEmitterOptions) {
    this.maxPerSession = opts.maxEventsPerSession ?? 1000;
  }

  /** Emit one event. Throws StreamEventTypeInvalid on non-canonical type. */
  emit(params: EmitParams): EmittedEvent {
    if (!STREAM_EVENT_TYPE_SET.has(params.type)) {
      throw new StreamEventTypeInvalid(params.type);
    }
    const nextSeq = (this.sequences.get(params.session_id) ?? -1) + 1;
    this.sequences.set(params.session_id, nextSeq);
    const event: EmittedEvent = {
      event_id: `evt_${randomBytes(6).toString("hex")}`,
      sequence: nextSeq,
      type: params.type as StreamEventType,
      session_id: params.session_id,
      emitted_at: this.opts.clock().toISOString(),
      payload: params.payload,
      ...(params.workflow_state_id !== undefined
        ? { workflow_state_id: params.workflow_state_id }
        : {})
    };
    const arr = this.events.get(params.session_id) ?? [];
    arr.push(event);
    if (arr.length > this.maxPerSession) arr.shift();
    this.events.set(params.session_id, arr);
    return event;
  }

  /** Read-only snapshot. Caller-owned; mutation doesn't affect the internal buffer. */
  snapshot(session_id: string): readonly EmittedEvent[] {
    return (this.events.get(session_id) ?? []).slice();
  }

  /** Total events across all sessions — diagnostic + metrics hook. */
  countAll(): number {
    let n = 0;
    for (const arr of this.events.values()) n += arr.length;
    return n;
  }

  /** Has this emitter seen any events for `session_id` yet? */
  hasSession(session_id: string): boolean {
    return this.events.has(session_id);
  }
}
