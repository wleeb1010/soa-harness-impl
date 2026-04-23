/**
 * Stream-event synthesizer — maps LangGraph `astream_events v2` events
 * to SOA-Harness §14.1 StreamEvents per §14.6 (informative mapping
 * table, M4 Phase 0a / spec commit 654dc7b).
 *
 * This module is responsible for the DIRECT mappings in §14.6.1 (14 of
 * 40 LangGraph events translate to SOA StreamEvent types) plus the
 * stateful ContentBlock-boundary derivation (ContentBlockStart emitted
 * on first stream chunk per run_id, ContentBlockEnd on the matching
 * chat-model-end).
 *
 * It deliberately does NOT synthesize §14.6.2 synthetic events
 * (MemoryLoad, PermissionPrompt, PermissionDecision, PreToolUseOutcome,
 * PostToolUseOutcome, ToolInputEnd, CrashEvent, Compaction*, Handoff*,
 * SelfImprovement*) — those originate outside the LangGraph event
 * stream and are woven in by the adapter's orchestrator at the correct
 * ordering points. See §18.5.2 for the pre-dispatch permission flow
 * and §15 for the hook-pipeline outcomes.
 *
 * Output `payload` values here are the minimum fields needed to match
 * fixture `payload_shape` invariants; final payload completion (event
 * IDs, timestamps, args_digests, etc.) is the orchestrator's job.
 */

/**
 * Closed 27-type StreamEvent enum per §14.1. Listed alphabetically within
 * group; matches schemas/vendored/stream-event.schema.json enum ordering
 * at the pinned spec commit.
 */
export type SoaStreamEventType =
  | "SessionStart"
  | "SessionEnd"
  | "MessageStart"
  | "MessageEnd"
  | "ContentBlockStart"
  | "ContentBlockDelta"
  | "ContentBlockEnd"
  | "ToolInputStart"
  | "ToolInputDelta"
  | "ToolInputEnd"
  | "ToolResult"
  | "ToolError"
  | "PermissionPrompt"
  | "PermissionDecision"
  | "PreToolUseOutcome"
  | "PostToolUseOutcome"
  | "MemoryLoad"
  | "CompactionStart"
  | "CompactionEnd"
  | "CrashEvent"
  | "HandoffStart"
  | "HandoffComplete"
  | "HandoffFailed"
  | "SelfImprovementStart"
  | "SelfImprovementAccepted"
  | "SelfImprovementRejected"
  | "SelfImprovementOrphaned";

/** Subset emitted by the direct mapper (the rest are orchestrator-synthesized). */
export type DirectMappedType =
  | "SessionStart"
  | "SessionEnd"
  | "MessageStart"
  | "MessageEnd"
  | "ContentBlockStart"
  | "ContentBlockDelta"
  | "ContentBlockEnd"
  | "ToolInputStart"
  | "ToolInputDelta"
  | "ToolResult"
  | "ToolError"
  | "PermissionPrompt";

/** Shape of a LangGraph astream_events v2 record as we observe it. */
export interface LangGraphEvent {
  event: string;
  run_id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** Partial SOA StreamEvent — payload is minimum-viable; orchestrator completes. */
export interface SoaStreamEventDraft {
  type: SoaStreamEventType;
  payload: Record<string, unknown>;
}

/**
 * Stateful mapper — carries per-run_id block state so ContentBlockStart
 * fires exactly once before the first ContentBlockDelta and
 * ContentBlockEnd exactly once after the matching chat-model-end.
 *
 * One mapper instance per session / per adapter invocation. Not
 * reentrant across sessions (would pollute block state).
 */
export class EventMapper {
  private readonly runState: Map<string, { blockStarted: boolean; blockId: string }> = new Map();
  private sessionStartEmitted = false;
  private sessionEndEmitted = false;

  map(event: LangGraphEvent): SoaStreamEventDraft[] {
    switch (event.event) {
      case "on_thread_start":
        return this.emitSessionStart(event);

      case "on_chain_start":
        // Root on_chain_start is redundant with on_thread_start per §14.6.1
        // "on_thread_start (or root on_chain_start) → SessionStart".
        // Non-root on_chain_start is dropped per the dropped-events table.
        if (this.isRoot(event) && !this.sessionStartEmitted) {
          return this.emitSessionStart(event);
        }
        return [];

      case "on_thread_end":
        return this.emitSessionEnd("Completed");

      case "on_chain_end":
        if (this.isRoot(event) && !this.sessionEndEmitted) {
          return this.emitSessionEnd("Completed");
        }
        return [];

      case "on_chain_error":
        if (this.isRoot(event)) {
          return this.emitSessionEnd("Failed");
        }
        return [];

      case "on_chat_model_start":
      case "on_llm_start":
        return [
          {
            type: "MessageStart",
            payload: {
              message_id: this.deriveMessageId(event),
              role: "assistant",
            },
          },
        ];

      case "on_chat_model_stream":
      case "on_llm_stream":
      case "on_text":
        return this.emitContentBlockDelta(event);

      case "on_chat_model_end":
      case "on_llm_end":
        return this.emitMessageEnd(event);

      case "on_tool_start":
        return [
          {
            type: "ToolInputStart",
            payload: {
              tool_call_id: event.run_id ?? "",
              tool_name: event.name ?? "",
            },
          },
        ];

      case "on_tool_stream":
        return [
          {
            type: "ToolInputDelta",
            payload: {
              tool_call_id: event.run_id ?? "",
              delta: this.extractDelta(event) ?? "",
            },
          },
        ];

      case "on_tool_end":
        return [
          {
            type: "ToolResult",
            payload: {
              tool_call_id: event.run_id ?? "",
              ok: true,
            },
          },
        ];

      case "on_tool_error":
        return [
          {
            type: "ToolError",
            payload: {
              tool_call_id: event.run_id ?? "",
              code: "unknown",
              message: this.extractErrorMessage(event),
            },
          },
        ];

      case "on_interrupt":
        // LangGraph's human-in-the-loop interrupt maps to PermissionPrompt per §14.6.1.
        // Note: when the adapter's pre-dispatch interception fires (§18.5.2), it also
        // synthesizes a PermissionPrompt independently — deduplication is the
        // orchestrator's job (one interrupt + one interception = one PermissionPrompt).
        return [
          {
            type: "PermissionPrompt",
            payload: {
              prompt_id: `prm_${event.run_id ?? ""}`,
            },
          },
        ];

      default:
        // All other events are dropped per §14.6.1 (non-root chain events,
        // checkpoint events, agent_action / agent_finish, prompt_* / parser_*,
        // retriever_*, custom_event, channel_*, state_update, graph_stream,
        // llm_error). Total: 22 dropped event kinds.
        return [];
    }
  }

  // --- helpers ----------------------------------------------------------

  private emitSessionStart(_event: LangGraphEvent): SoaStreamEventDraft[] {
    if (this.sessionStartEmitted) return [];
    this.sessionStartEmitted = true;
    return [{ type: "SessionStart", payload: {} }];
  }

  private emitSessionEnd(stopReason: "Completed" | "Failed"): SoaStreamEventDraft[] {
    if (this.sessionEndEmitted) return [];
    this.sessionEndEmitted = true;
    return [{ type: "SessionEnd", payload: { stop_reason: stopReason } }];
  }

  private emitContentBlockDelta(event: LangGraphEvent): SoaStreamEventDraft[] {
    const runId = event.run_id ?? "";
    const delta = this.extractDelta(event);
    if (delta === null) return [];
    const out: SoaStreamEventDraft[] = [];
    let st = this.runState.get(runId);
    if (!st) {
      st = { blockStarted: false, blockId: `blk_${runId}` };
      this.runState.set(runId, st);
    }
    if (!st.blockStarted) {
      out.push({
        type: "ContentBlockStart",
        payload: { block_id: st.blockId, content_type: "text" },
      });
      st.blockStarted = true;
    }
    out.push({
      type: "ContentBlockDelta",
      payload: { block_id: st.blockId, delta },
    });
    return out;
  }

  private emitMessageEnd(event: LangGraphEvent): SoaStreamEventDraft[] {
    const runId = event.run_id ?? "";
    const out: SoaStreamEventDraft[] = [];
    const st = this.runState.get(runId);
    if (st?.blockStarted) {
      out.push({
        type: "ContentBlockEnd",
        payload: { block_id: st.blockId },
      });
    }
    out.push({
      type: "MessageEnd",
      payload: { message_id: this.deriveMessageId(event) },
    });
    this.runState.delete(runId);
    return out;
  }

  private isRoot(event: LangGraphEvent): boolean {
    return event.metadata?.is_root === true;
  }

  private deriveMessageId(event: LangGraphEvent): string {
    return `msg_${event.run_id ?? ""}`;
  }

  private extractDelta(event: LangGraphEvent): string | null {
    const chunk = event.data?.chunk;
    if (typeof chunk === "string") return chunk;
    if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
      const c = (chunk as { content?: unknown }).content;
      if (typeof c === "string") return c;
    }
    return null;
  }

  private extractErrorMessage(event: LangGraphEvent): string {
    const raw = event.data?.error ?? event.data?.exception ?? "";
    const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
    return msg.slice(0, 1024);
  }
}
