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
 * Streaming mode is deliberately NOT in this interface for the M7 skeleton —
 * it wires into the §14 StreamEventEmitter and is layered on top in M8 once
 * the chat-UI work needs it. M7 ships synchronous dispatch only, which is
 * enough for SV-LLM-01..07 conformance.
 */

import type { DispatchRequest, DispatchResponse } from "./types.js";

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
}
