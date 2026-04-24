/**
 * Dispatcher error taxonomy per Core §16.3.1 (v1.1).
 *
 * The dispatcher NEVER surfaces raw provider error shapes to the Runner.
 * Every provider condition is classified into one of the taxonomy rows below
 * and returned as a synthetic DispatchResponse with stop_reason="DispatcherError"
 * and dispatcher_error_code set to the canonical string.
 *
 * Numeric subcodes (§24) live alongside the enum string for JSON-RPC
 * compatibility with §16.3.1 table.
 */

import type { DispatcherErrorCode } from "./types.js";

/**
 * Subcode-per-error mapping per §16.3.1 / §24.
 * JSON-RPC-aligned numeric codes: -32100..-32105 for provider conditions,
 * -32110 for dispatcher-internal request-invalid.
 */
export const DISPATCHER_ERROR_SUBCODES: Record<DispatcherErrorCode, number> = {
  ProviderRateLimited: -32100,
  ProviderAuthFailed: -32101,
  ProviderUnavailable: -32102,
  ProviderNetworkFailed: -32103,
  ContentFilterRefusal: -32104,
  ContextLengthExceeded: -32105,
  DispatcherRequestInvalid: -32110,
};

/**
 * Which error conditions are retryable by the dispatcher. Retryable errors
 * are rate-limit, provider-5xx, and network failures. Everything else is
 * terminal on first encounter.
 *
 * Per §16.3.1: "Retry budgets apply to the dispatcher call as a whole — 3
 * retries total across rate-limit, 5xx, and network conditions; switching
 * between those conditions does NOT reset the counter."
 */
export const RETRYABLE_ERRORS: ReadonlySet<DispatcherErrorCode> = new Set<DispatcherErrorCode>([
  "ProviderRateLimited",
  "ProviderUnavailable",
  "ProviderNetworkFailed",
]);

/** §16.3.1 retry cap, shared across all retryable classes. */
export const MAX_DISPATCHER_RETRIES = 3;

/**
 * Adapter-raised error shape. Adapters throw one of these to signal provider
 * conditions to the dispatcher; the dispatcher classifies + aggregates +
 * retries per §16.3.1 and produces the final DispatcherError response.
 */
export class AdapterError extends Error {
  public readonly code: DispatcherErrorCode;
  public readonly providerRequestId: string | null;
  public readonly retryAfterMs: number | null;

  constructor(
    code: DispatcherErrorCode,
    opts: { message?: string; providerRequestId?: string | null; retryAfterMs?: number | null } = {},
  ) {
    super(opts.message ?? `AdapterError: ${code}`);
    this.name = "AdapterError";
    this.code = code;
    this.providerRequestId = opts.providerRequestId ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/**
 * Map an AdapterError (or an unknown throwable) into the canonical code.
 *
 * Any non-AdapterError is classified as ProviderNetworkFailed by default —
 * dispatcher cannot distinguish an adapter bug from an upstream glitch
 * without an explicit adapter contract, so it errs toward "transient, retry."
 * Adapters that want finer classification MUST throw AdapterError.
 */
export function classifyThrowable(err: unknown): DispatcherErrorCode {
  if (err instanceof AdapterError) return err.code;
  return "ProviderNetworkFailed";
}
