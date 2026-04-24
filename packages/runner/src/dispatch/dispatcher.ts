/**
 * Dispatcher — Core §16.3 lifecycle orchestrator.
 *
 * One dispatcher instance per Runner. The dispatcher owns:
 *   - Request validation (against @soa-harness/schemas llm-dispatch-request)
 *   - Budget pre-check (§13.1 projection — BEFORE any provider call)
 *   - Adapter invocation + retry budget (§16.3.1 — 3 total across retryables)
 *   - Cancellation target registration (§13.2 mid-stream)
 *   - Dispatch audit row emission (§10.5 hash-chained, one per dispatch)
 *   - Recent-dispatches ring buffer feeding /dispatch/recent (§16.4)
 *
 * The dispatcher is provider-agnostic. Every ProviderAdapter plugs in via the
 * same interface; v1.1 ships one adapter (InMemoryTestAdapter for tests);
 * real adapters (OpenAI, Anthropic, etc.) are adopter-written and not
 * shipped in v1.1.
 *
 * Cancellation semantics:
 *   - Runner creates an AbortController per turn and passes signal in via opts.signal
 *   - Dispatcher creates its own internal controller linked to that signal
 *   - Aborting the external signal aborts the internal one + stops retry loop
 *   - Adapters MUST honor the signal passed in ctx (see adapter.ts contract)
 *
 * Retry backoff:
 *   - Honors AdapterError.retryAfterMs if set (e.g. from a 429 Retry-After header)
 *   - Otherwise: exponential backoff with full-jitter per AWS-style policy —
 *     delay = random(0, base * 2^attempt), base = 100ms
 *   - Capped at 5000ms per attempt to keep tail latency bounded
 */

import { registry, type Validator } from "@soa-harness/schemas";
import type { BudgetTracker } from "../budget/index.js";
import type { AuditChain } from "../audit/index.js";
import type { ProviderAdapter } from "./adapter.js";
import {
  AdapterError,
  MAX_DISPATCHER_RETRIES,
  RETRYABLE_ERRORS,
  DISPATCHER_ERROR_SUBCODES,
  classifyThrowable,
} from "./errors.js";
import type {
  DispatchRequest,
  DispatchResponse,
  DispatchRecentRow,
  DispatchRecentResponse,
  DispatcherErrorCode,
} from "./types.js";

const DEFAULT_RECENT_RING = 500;
const DEFAULT_RUNNER_VERSION = "1.1";
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

export interface DispatcherOptions {
  /** The single provider adapter wired up for this Runner. */
  adapter: ProviderAdapter;
  /**
   * Budget tracker for §13.1 pre-check. Optional — if omitted, dispatcher
   * skips the pre-check step (useful for minimal test setups or early-stage
   * Runners not yet wiring budget). Production Runners MUST supply one.
   */
  budgetTracker?: BudgetTracker;
  /**
   * Audit chain for §10.5 hash-chained dispatch audit rows. Optional — if
   * omitted, dispatcher skips audit row emission. Production Runners MUST
   * supply one.
   */
  auditChain?: AuditChain;
  /** Deterministic clock for tests. Defaults to `new Date()`. */
  clock?: () => Date;
  /** Runner version echoed in /dispatch/recent. Defaults to "1.1". */
  runnerVersion?: string;
  /** Max dispatches retained for /dispatch/recent per session. Defaults to 500. */
  recentRingBuffer?: number;
  /**
   * Deterministic random for backoff jitter. Defaults to Math.random. Tests
   * pass a fixed generator to pin sleep durations.
   */
  random?: () => number;
  /**
   * Deterministic sleep. Defaults to setTimeout. Tests inject a fake timer
   * to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

interface DispatcherLimits {
  maxRetries: number;
}

export class Dispatcher {
  private readonly adapter: ProviderAdapter;
  private readonly budget: BudgetTracker | null;
  private readonly audit: AuditChain | null;
  private readonly clock: () => Date;
  private readonly runnerVersion: string;
  private readonly recentRingSize: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly recent = new Map<string, DispatchRecentRow[]>();
  private readonly requestValidator: Validator;
  private readonly responseValidator: Validator;
  public readonly limits: DispatcherLimits = { maxRetries: MAX_DISPATCHER_RETRIES };

  constructor(opts: DispatcherOptions) {
    this.adapter = opts.adapter;
    this.budget = opts.budgetTracker ?? null;
    this.audit = opts.auditChain ?? null;
    this.clock = opts.clock ?? (() => new Date());
    this.runnerVersion = opts.runnerVersion ?? DEFAULT_RUNNER_VERSION;
    this.recentRingSize = opts.recentRingBuffer ?? DEFAULT_RECENT_RING;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.requestValidator = registry["llm-dispatch-request"];
    this.responseValidator = registry["llm-dispatch-response"];
  }

  /**
   * Fire a dispatch. Returns a DispatchResponse regardless of success or
   * failure — callers look at `stop_reason` / `dispatcher_error_code`.
   *
   * Throws only in cases of caller error (e.g. dispatcher not configured).
   * Provider failures, cancellations, budget exhaustion are all returned
   * as valid DispatchResponse instances — that is the §16.3 contract.
   */
  async dispatch(
    request: DispatchRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<DispatchResponse> {
    const started = this.clock();

    // Step 1: validate request against schema
    if (!this.requestValidator(request)) {
      return this.synthesizeError({
        request,
        started,
        completed: this.clock(),
        code: "DispatcherRequestInvalid",
        contentBlocks: [
          {
            type: "refusal",
            text: `Dispatcher request failed schema: ${JSON.stringify(this.requestValidator.errors ?? [])}`,
          },
        ],
      });
    }

    // Step 2: §13.1 budget pre-check (if tracker wired)
    if (this.budget && this.budget.has(request.session_id)) {
      const projection = this.budget.getProjection(request.session_id);
      if (projection) {
        const projected =
          projection.cumulative_tokens_consumed + projection.p95_tokens_per_turn_over_window_w * 1.15;
        if (projected > request.budget_ceiling_tokens) {
          return this.synthesizeBudgetExhausted({ request, started, completed: this.clock() });
        }
      }
    }

    // Step 3: billing_tag propagation is implicit — adapter receives the
    // billing_tag field in DispatchRequest. Audit row records it after.
    // OTel span wiring is layered on in M11 observability milestone; for
    // the M7 skeleton we only touch the audit path.

    // Step 4: cancellation — use caller's signal OR create internal one
    const controller = new AbortController();
    let unlink: (() => void) | null = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort(opts.signal.reason);
      } else {
        const onAbort = () => controller.abort(opts.signal!.reason);
        opts.signal.addEventListener("abort", onAbort, { once: true });
        unlink = () => opts.signal!.removeEventListener("abort", onAbort);
      }
    }

    try {
      // Step 5: adapter call with retry loop per §16.3.1
      const response = await this.invokeWithRetry(request, controller.signal, started);
      return response;
    } finally {
      unlink?.();
    }
  }

  /**
   * §16.4 /dispatch/recent response envelope. Returns newest-first, capped
   * at `limit` (default 50, max 500 per spec). Not-a-side-effect.
   */
  recent_response(session_id: string, limit: number = 50): DispatchRecentResponse {
    const cap = Math.min(Math.max(1, limit), this.recentRingSize);
    const rows = this.recent.get(session_id) ?? [];
    return {
      session_id,
      dispatches: rows.slice(0, cap),
      runner_version: this.runnerVersion,
      generated_at: this.clock().toISOString(),
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  private async invokeWithRetry(
    request: DispatchRequest,
    signal: AbortSignal,
    started: Date,
  ): Promise<DispatchResponse> {
    let attempt = 1;
    let lastError: AdapterError | null = null;

    while (attempt <= this.limits.maxRetries + 1) {
      if (signal.aborted) {
        return this.synthesizeCancelled({ request, started, completed: this.clock() });
      }

      try {
        const response = await this.adapter.dispatch(request, { signal, attempt });
        // Echo-check critical fields per §16.3 adapter contract
        if (
          response.session_id !== request.session_id ||
          response.turn_id !== request.turn_id ||
          response.billing_tag !== request.billing_tag ||
          response.correlation_id !== request.correlation_id
        ) {
          // Adapter violated echo contract; classify as internal error.
          const bad = this.synthesizeError({
            request,
            started,
            completed: this.clock(),
            code: "DispatcherRequestInvalid",
            contentBlocks: [
              {
                type: "refusal",
                text: "Adapter violated echo contract (session_id/turn_id/billing_tag/correlation_id mismatch)",
              },
            ],
          });
          this.recordDispatch(bad, request, started);
          return bad;
        }
        // Success — response passes through unchanged, attach audit + ring
        this.recordDispatch(response, request, started);
        return response;
      } catch (err: unknown) {
        // Cancellation thrown synchronously by the adapter looks like a
        // generic abort Error. Honor it as UserInterrupt.
        if (signal.aborted) {
          const cancelled = this.synthesizeCancelled({ request, started, completed: this.clock() });
          this.recordDispatch(cancelled, request, started);
          return cancelled;
        }

        const code = classifyThrowable(err);
        const adapterErr =
          err instanceof AdapterError
            ? err
            : new AdapterError(code, { message: (err as Error)?.message });
        lastError = adapterErr;

        if (!RETRYABLE_ERRORS.has(code) || attempt > this.limits.maxRetries) {
          const final = this.synthesizeError({
            request,
            started,
            completed: this.clock(),
            code,
            providerRequestId: adapterErr.providerRequestId,
            contentBlocks:
              code === "ContentFilterRefusal"
                ? [{ type: "refusal", text: adapterErr.message }]
                : [],
          });
          this.recordDispatch(final, request, started);
          return final;
        }

        // Retryable — back off
        const delay = adapterErr.retryAfterMs ?? this.jitteredBackoff(attempt);
        await this.sleep(delay);
        attempt++;
      }
    }

    // Exhausted retry budget — produce the classified error
    const code = lastError?.code ?? "ProviderNetworkFailed";
    const final = this.synthesizeError({
      request,
      started,
      completed: this.clock(),
      code,
      providerRequestId: lastError?.providerRequestId ?? null,
    });
    this.recordDispatch(final, request, started);
    return final;
  }

  private jitteredBackoff(attempt: number): number {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(this.random() * ceiling);
  }

  private synthesizeBudgetExhausted(args: {
    request: DispatchRequest;
    started: Date;
    completed: Date;
  }): DispatchResponse {
    const response: DispatchResponse = {
      dispatch_id: this.mintDispatchId(args.request.turn_id, args.started),
      session_id: args.request.session_id,
      turn_id: args.request.turn_id,
      content_blocks: [],
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      stop_reason: "BudgetExhausted",
      dispatcher_error_code: null,
      latency_ms: Math.max(0, args.completed.getTime() - args.started.getTime()),
      provider_request_id: null,
      provider: this.adapter.name,
      model_echo: args.request.model,
      billing_tag: args.request.billing_tag,
      correlation_id: args.request.correlation_id,
      generated_at: args.completed.toISOString(),
    };
    this.recordDispatch(response, args.request, args.started);
    return response;
  }

  private synthesizeCancelled(args: {
    request: DispatchRequest;
    started: Date;
    completed: Date;
  }): DispatchResponse {
    return {
      dispatch_id: this.mintDispatchId(args.request.turn_id, args.started),
      session_id: args.request.session_id,
      turn_id: args.request.turn_id,
      content_blocks: [],
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      stop_reason: "UserInterrupt",
      dispatcher_error_code: null,
      latency_ms: Math.max(0, args.completed.getTime() - args.started.getTime()),
      provider_request_id: null,
      provider: this.adapter.name,
      model_echo: args.request.model,
      billing_tag: args.request.billing_tag,
      correlation_id: args.request.correlation_id,
      generated_at: args.completed.toISOString(),
    };
  }

  private synthesizeError(args: {
    request: DispatchRequest;
    started: Date;
    completed: Date;
    code: DispatcherErrorCode;
    providerRequestId?: string | null;
    contentBlocks?: DispatchResponse["content_blocks"];
  }): DispatchResponse {
    return {
      dispatch_id: this.mintDispatchId(args.request.turn_id, args.started),
      session_id: args.request.session_id,
      turn_id: args.request.turn_id,
      content_blocks: args.contentBlocks ?? [],
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
      stop_reason: "DispatcherError",
      dispatcher_error_code: args.code,
      latency_ms: Math.max(0, args.completed.getTime() - args.started.getTime()),
      provider_request_id: args.providerRequestId ?? null,
      provider: this.adapter.name,
      model_echo: args.request.model,
      billing_tag: args.request.billing_tag,
      correlation_id: args.request.correlation_id,
      generated_at: args.completed.toISOString(),
    };
  }

  private mintDispatchId(turn_id: string, started: Date): string {
    // Pattern: ^dsp_[A-Za-z0-9]{16,}$ — the prefix keeps its underscore; only
    // the suffix is constrained to alphanumeric.
    const rand = Math.floor(this.random() * 2 ** 32)
      .toString(36)
      .padStart(8, "0");
    const t = started.getTime().toString(36);
    const suffixRaw = `${turn_id.slice(4, 12)}${t}${rand}`;
    const suffix = suffixRaw.replace(/[^A-Za-z0-9]/g, "x");
    const padded = suffix.length >= 16 ? suffix : suffix.padEnd(16, "x");
    return `dsp_${padded.slice(0, 28)}`;
  }

  /**
   * Step 6 — record a dispatch into BOTH the /dispatch/recent ring buffer
   * AND the §10.5 audit chain (when wired). Exactly one audit row per
   * dispatch regardless of success/cancel/error per §16.3 lifecycle.
   */
  private recordDispatch(response: DispatchResponse, request: DispatchRequest, started: Date): void {
    const now = this.clock();
    const row: DispatchRecentRow = {
      dispatch_id: response.dispatch_id,
      turn_id: response.turn_id,
      provider: response.provider,
      model_echo: response.model_echo,
      stop_reason: response.stop_reason,
      dispatcher_error_code: response.dispatcher_error_code,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cached_tokens: response.usage.cached_tokens ?? 0,
      },
      latency_ms: response.latency_ms,
      billing_tag: response.billing_tag,
      correlation_id: response.correlation_id,
      provider_request_id: response.provider_request_id,
      started_at: started.toISOString(),
      completed_at: now.toISOString(),
    };

    // Ring buffer — newest first
    const rows = this.recent.get(request.session_id) ?? [];
    rows.unshift(row);
    if (rows.length > this.recentRingSize) rows.length = this.recentRingSize;
    this.recent.set(request.session_id, rows);

    // Audit chain — one row per dispatch, hash-chained
    if (this.audit) {
      this.audit.append({
        timestamp: now.toISOString(),
        kind: "dispatch",
        dispatch_id: response.dispatch_id,
        session_id: response.session_id,
        turn_id: response.turn_id,
        billing_tag: response.billing_tag,
        stop_reason: response.stop_reason,
        dispatcher_error_code: response.dispatcher_error_code,
        provider: response.provider,
        provider_request_id: response.provider_request_id,
        usage: row.usage,
        latency_ms: response.latency_ms,
        subcode:
          response.dispatcher_error_code !== null
            ? DISPATCHER_ERROR_SUBCODES[response.dispatcher_error_code]
            : null,
      });
    }
  }

  /**
   * §16.6 streaming-mode audit row. Synthesizes a DispatchResponse from the
   * stream's terminal state so the existing recordDispatch pipeline (ring
   * buffer + hash-chained audit) stays single-source-of-truth for all
   * dispatch rows regardless of mode.
   */
  recordStreamDispatch(args: {
    request: DispatchRequest;
    stop_reason: DispatchResponse["stop_reason"];
    dispatcher_error_code: DispatchResponse["dispatcher_error_code"];
    usage: { input_tokens: number; output_tokens: number; cached_tokens?: number };
    started_at: string;
    completed_at: string;
  }): void {
    const started = new Date(args.started_at);
    const completed = new Date(args.completed_at);
    const response: DispatchResponse = {
      dispatch_id: `dsp_${args.request.turn_id.slice(4)}s1`.padEnd(20, "x").slice(0, 20),
      session_id: args.request.session_id,
      turn_id: args.request.turn_id,
      content_blocks: [],
      tool_calls: [],
      usage: args.usage,
      stop_reason: args.stop_reason,
      dispatcher_error_code: args.dispatcher_error_code,
      latency_ms: Math.max(0, completed.getTime() - started.getTime()),
      provider_request_id: null,
      provider: this.adapter.name,
      model_echo: args.request.model,
      billing_tag: args.request.billing_tag,
      correlation_id: args.request.correlation_id,
      generated_at: completed.toISOString(),
    };
    this.recordDispatch(response, args.request, started);
  }
}
