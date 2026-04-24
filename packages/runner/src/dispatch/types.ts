/**
 * Types for the LLM dispatcher per Core §16.3 (v1.1).
 *
 * These TS types mirror the wire schemas:
 *   - schemas/llm-dispatch-request.schema.json
 *   - schemas/llm-dispatch-response.schema.json
 *   - schemas/dispatch-recent-response.schema.json
 *
 * The SOURCE OF TRUTH is the schema; these types are a faithful hand-mapping.
 * Runtime validation goes through the ajv-compiled validator in
 * @soa-harness/schemas — the types here exist for TS compile-time ergonomics.
 */

export type DispatchRole = "system" | "user" | "assistant" | "tool";

export interface DispatchContentBlock {
  type: "text" | "image" | "tool_result" | "tool_use";
  [extra: string]: unknown;
}

export interface DispatchMessage {
  role: DispatchRole;
  content: string | DispatchContentBlock[];
  tool_call_id?: string;
  name?: string;
}

export interface DispatchToolDescriptor {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

/**
 * Dispatch request envelope (§16.3 request contract).
 *
 * REQUIRED: session_id, turn_id, model, messages, budget_ceiling_tokens,
 * billing_tag, correlation_id, idempotency_key.
 */
export interface DispatchRequest {
  session_id: string;
  turn_id: string;
  model: string;
  messages: DispatchMessage[];
  budget_ceiling_tokens: number;
  billing_tag: string;
  correlation_id: string;
  idempotency_key: string;
  /** Optional; adapters MAY map to provider-native tool schemas. */
  tools?: DispatchToolDescriptor[];
  /** Default true. When false, dispatcher uses synchronous response contract. */
  stream?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
}

/**
 * The §13.4 closed StopReason enum including the v1.1 DispatcherError
 * addition. Keep in sync with the spec.
 */
export type StopReason =
  | "NaturalStop"
  | "MaxTurns"
  | "UserInterrupt"
  | "BudgetExhausted"
  | "MemoryDegraded"
  | "CardVersionDrift"
  | "ToolPoolStale"
  | "SelfImproveLockBusy"
  | "Crash"
  | "DispatcherError";

/**
 * §16.3.1 dispatcher_error_code observability field. Non-null iff
 * stop_reason === "DispatcherError".
 */
export type DispatcherErrorCode =
  | "ProviderRateLimited"
  | "ProviderAuthFailed"
  | "ProviderUnavailable"
  | "ProviderNetworkFailed"
  | "ContentFilterRefusal"
  | "ContextLengthExceeded"
  | "DispatcherRequestInvalid"
  | "DispatcherStreamUnsupported"
  | "DispatcherAdapterError";

export interface DispatchUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  cache_accounting_ratio?: number;
}

export interface DispatchToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Dispatch response envelope (§16.3 response contract, synchronous mode).
 */
export interface DispatchResponse {
  dispatch_id: string;
  session_id: string;
  turn_id: string;
  content_blocks: Array<{ type: "text" | "refusal"; text?: string; [extra: string]: unknown }>;
  tool_calls: DispatchToolCall[];
  usage: DispatchUsage;
  stop_reason: StopReason;
  /** Non-null iff stop_reason === "DispatcherError". */
  dispatcher_error_code: DispatcherErrorCode | null;
  latency_ms: number;
  provider_request_id: string | null;
  provider: string;
  model_echo: string;
  billing_tag: string;
  correlation_id: string;
  generated_at: string;
}

/**
 * §16.4 /dispatch/recent response row.
 */
export interface DispatchRecentRow {
  dispatch_id: string;
  turn_id: string;
  provider: string;
  model_echo: string;
  stop_reason: StopReason;
  dispatcher_error_code: DispatcherErrorCode | null;
  usage: DispatchUsage;
  latency_ms: number;
  billing_tag: string;
  correlation_id: string;
  provider_request_id?: string | null;
  started_at: string;
  completed_at: string;
}

/**
 * §16.4 /dispatch/recent response envelope.
 */
export interface DispatchRecentResponse {
  session_id: string;
  dispatches: DispatchRecentRow[];
  runner_version: string;
  generated_at: string;
}

/**
 * §16.6 Streaming Dispatcher — StreamedDispatchEvent.
 *
 * Adapters that implement dispatchStream yield these events, which the
 * dispatcher wraps into SSE frames per §16.6.2. The event types map 1-for-1
 * onto the §14.1 StreamEvent closed enum; the dispatch layer enforces the
 * §16.6.3 sequence invariants.
 *
 * Intentionally a narrow subset of the §14.1 enum: a dispatch stream only
 * ever carries the five message-content events, not session-level events like
 * SessionStart or tool events. The full §14.1 stream observed at /events/recent
 * is a superset that stitches multiple dispatch streams together with
 * session/tool framing.
 */
export interface StreamedDispatchEvent {
  type:
    | "MessageStart"
    | "ContentBlockStart"
    | "ContentBlockDelta"
    | "ContentBlockEnd"
    | "MessageEnd";
  /** Monotonic per-session sequence counter (dispatcher-managed). */
  sequence: number;
  /** ISO 8601 instant. */
  emitted_at: string;
  /** Dispatch correlation — same as request.correlation_id. */
  correlation_id: string;
  /** Session ID — same as request.session_id. */
  session_id: string;
  /** Present on MessageStart — echoes request turn_id. */
  turn_id?: string;
  /** Present on ContentBlockStart / ContentBlockEnd — zero-based index within this message. */
  content_block_index?: number;
  /** Present on ContentBlockStart — block type classification. */
  content_block_type?: "text" | "tool_use" | "image";
  /** Present on ContentBlockDelta — incremental payload since the previous delta. */
  delta?: { text?: string; partial_json?: string };
  /** Present on MessageEnd — final stop classification and usage. */
  stop_reason?: StopReason;
  dispatcher_error_code?: DispatcherErrorCode | null;
  usage?: DispatchUsage;
}
