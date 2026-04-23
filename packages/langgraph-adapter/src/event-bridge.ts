/**
 * Event bridge — Phase 2.6.
 *
 * Wires the adapter's `EventMapper` output into a `StreamEventEmitter`
 * (from @soa-harness/runner) so synthesized SOA StreamEvents reach the
 * adapter's /events/recent endpoint.
 *
 * Two emission paths:
 *   1. `dispatch(langgraphEvent)` — feed a LangGraph astream_events v2
 *      record through the mapper; every direct-mapped SOA event is
 *      emitted in order.
 *   2. `emitSynthetic(type, payload)` — bypass the mapper to emit a
 *      §14.6.2 synthetic event (MemoryLoad, PermissionPrompt,
 *      PermissionDecision, PreToolUseOutcome, PostToolUseOutcome,
 *      ToolInputEnd, etc.). Orchestrator-sourced; origin is outside
 *      the LangGraph event stream.
 *
 * Session-scoped — one bridge instance per agent session. The session
 * id is the /events/recent scope boundary.
 */

import type { StreamEventEmitter } from "@soa-harness/runner";
import { EventMapper, type LangGraphEvent, type SoaStreamEventType } from "./stream-event-synth.js";

export interface EventBridgeOptions {
  emitter: StreamEventEmitter;
  sessionId: string;
  /** Optional: use a caller-supplied mapper (e.g. to share state across bridges). Default: fresh EventMapper. */
  mapper?: EventMapper;
}

export class EventBridge {
  private readonly emitter: StreamEventEmitter;
  private readonly sessionId: string;
  private readonly mapper: EventMapper;

  constructor(opts: EventBridgeOptions) {
    this.emitter = opts.emitter;
    this.sessionId = opts.sessionId;
    this.mapper = opts.mapper ?? new EventMapper();
  }

  /**
   * Feed one LangGraph event. Emits zero-or-more SOA StreamEvents per
   * §14.6.1 direct-mapping rules. Returns the count emitted (useful for
   * test assertions + flow control).
   */
  dispatch(event: LangGraphEvent): number {
    const drafts = this.mapper.map(event);
    for (const draft of drafts) {
      this.emitter.emit({
        session_id: this.sessionId,
        type: draft.type,
        payload: draft.payload,
      });
    }
    return drafts.length;
  }

  /**
   * Emit a §14.6.2 synthetic event directly. Reserved for
   * orchestrator-sourced events (permission + memory + hook outcomes)
   * whose origin is outside the LangGraph event stream.
   */
  emitSynthetic(type: SoaStreamEventType, payload: Record<string, unknown>): void {
    this.emitter.emit({
      session_id: this.sessionId,
      type,
      payload,
    });
  }
}
