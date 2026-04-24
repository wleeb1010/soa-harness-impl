/**
 * ProviderAdapter — the interface every LLM adapter implements to plug into
 * the §16.3 dispatcher.
 *
 * Adapters are NOT responsible for:
 *   - Budget projection pre-check (§13.1) — dispatcher does this BEFORE calling
 *   - Billing-tag propagation to OTel — dispatcher does this
 *   - Cancellation token registration — dispatcher owns the AbortSignal
 *   - Audit row recording — dispatcher writes exactly one per dispatch
 *   - Retry policy — dispatcher owns the retry budget
 *
 * Adapters ARE responsible for:
 *   - Provider-specific request shaping + auth
 *   - Provider-specific error classification (throw AdapterError with the
 *     correct DispatcherErrorCode when a provider condition is detected)
 *   - Respecting the AbortSignal passed in — when it aborts mid-stream,
 *     the adapter MUST close its provider stream promptly; buffered content
 *     MUST NOT leak after abort
 *   - Returning a complete DispatchResponse on synchronous-mode success
 *
 * Streaming mode landed in M8 (v1.2 per §16.6) as the optional dispatchStream
 * method. Adapters that only implement the synchronous dispatch path remain
 * v1.0-conformant; streaming-capable adapters advertise that capability via
 * the optional dispatchStream method and flip SV-LLM-05 from skip to live.
 */

import type { DispatchRequest, DispatchResponse, StreamedDispatchEvent } from "./types.js";

export interface AdapterDispatchContext {
  /** Abort signal — adapters MUST respect this to honor §13.2 cancellation. */
  signal: AbortSignal;
  /** When set, used for replay / idempotency. */
  attempt: number;
}

export interface ProviderAdapter {
  /**
   * A stable human-readable identifier. Echoed back in DispatchResponse.provider.
   * Runner MUST NOT key routing off this value.
   */
  readonly name: string;

  /**
   * Fire a single synchronous dispatch. Adapters MAY internally retry provider
   * transients below the AdapterError threshold, but MUST surface final
   * failure as AdapterError. Dispatcher-level retry budget (3) sits above
   * anything the adapter does.
   *
   * The returned response's billing_tag, correlation_id, session_id, turn_id
   * MUST echo the request's values. Dispatcher validates this echo.
   */
  dispatch(request: DispatchRequest, ctx: AdapterDispatchContext): Promise<DispatchResponse>;

  /**
   * §16.6.1 — optional streaming-mode dispatch. When implemented, the adapter
   * MUST yield StreamedDispatchEvent items that the dispatcher wraps into the
   * SSE response framing per §16.6.2. Adapters that do not provide this method
   * advertise sync-only capability; the dispatcher returns HTTP 406
   * DispatcherStreamUnsupported when a streaming request targets such an
   * adapter.
   *
   * The yielded events follow the §14.1 StreamEvent closed enum (MessageStart,
   * ContentBlockStart, ContentBlockDelta, ContentBlockEnd, MessageEnd). The
   * dispatcher enforces the §16.6.3 sequence invariants; adapters that violate
   * them surface as DispatcherAdapterError.
   *
   * Abort semantics: when ctx.signal fires, the adapter MUST stop emitting new
   * ContentBlockDelta events at the next boundary. Adapters MAY emit a
   * terminal ContentBlockEnd + MessageEnd pair after abort to close a
   * half-open block; MUST stop iterating after that pair.
   */
  dispatchStream?(
    request: DispatchRequest,
    ctx: AdapterDispatchContext,
  ): AsyncIterable<StreamedDispatchEvent>;
}
