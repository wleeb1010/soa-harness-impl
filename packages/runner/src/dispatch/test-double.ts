/**
 * InMemoryTestAdapter — a fixture ProviderAdapter for unit tests and
 * §16.3 SV-LLM-03/05/06/07 conformance probes.
 *
 * NOT a real LLM adapter. NOT safe to ship in production. Exists to make
 * dispatcher lifecycle testable without any network dependency.
 *
 * Behaviors the adapter can be programmed to produce:
 *   - "ok" — returns a synthetic success response echoing the request
 *   - "error:<code>" — throws AdapterError with the given DispatcherErrorCode,
 *     e.g. "error:ProviderRateLimited"
 *   - "flaky:N:<code>" — throws AdapterError with the given code for the
 *     first N attempts, then succeeds. Useful for SV-LLM-07 retry-budget
 *     tests (flaky:2:ProviderRateLimited should retry twice and then succeed)
 *   - "never" — hangs (useful for cancellation tests)
 *
 * The adapter records every invocation via `calls` so tests can assert
 * BOTH that a call fired (success path) AND that none fired (budget-gate
 * prevented network activity — SV-LLM-03).
 */

import { AdapterError } from "./errors.js";
import type { ProviderAdapter, AdapterDispatchContext } from "./adapter.js";
import type { DispatchRequest, DispatchResponse, DispatcherErrorCode } from "./types.js";

export interface TestAdapterCall {
  request: DispatchRequest;
  attempt: number;
  aborted: boolean;
  at: number;
}

export interface InMemoryTestAdapterOptions {
  /** Behavior string. Defaults to "ok". */
  behavior?: string;
  /** Deterministic now() for latency_ms stamping. Defaults to Date.now. */
  now?: () => number;
  /**
   * Synthetic usage block on success. Defaults to input=100, output=50,
   * cached=0. Tests can override to drive budget-gate edge cases.
   */
  usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number };
}

export class InMemoryTestAdapter implements ProviderAdapter {
  public readonly name = "in-memory-test-adapter";
  public readonly calls: TestAdapterCall[] = [];
  private readonly now: () => number;
  private behavior: string;
  private readonly usage: { input_tokens: number; output_tokens: number; cached_tokens: number };

  constructor(opts: InMemoryTestAdapterOptions = {}) {
    this.behavior = opts.behavior ?? "ok";
    this.now = opts.now ?? (() => Date.now());
    this.usage = {
      input_tokens: opts.usage?.input_tokens ?? 100,
      output_tokens: opts.usage?.output_tokens ?? 50,
      cached_tokens: opts.usage?.cached_tokens ?? 0,
    };
  }

  setBehavior(b: string): void {
    this.behavior = b;
  }

  async dispatch(request: DispatchRequest, ctx: AdapterDispatchContext): Promise<DispatchResponse> {
    const started = this.now();
    const call: TestAdapterCall = {
      request,
      attempt: ctx.attempt,
      aborted: false,
      at: started,
    };
    this.calls.push(call);

    // "never" → hang until aborted (cancellation probe)
    if (this.behavior === "never") {
      return new Promise<DispatchResponse>((_resolve, reject) => {
        const onAbort = () => {
          call.aborted = true;
          reject(new Error("aborted"));
        };
        if (ctx.signal.aborted) {
          onAbort();
          return;
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    // "error:<CODE>" → fail every attempt
    const errMatch = /^error:(\w+)$/.exec(this.behavior);
    if (errMatch) {
      throw new AdapterError(errMatch[1] as DispatcherErrorCode, {
        message: `test-double: programmed ${errMatch[1]}`,
        providerRequestId: `test-req-${this.calls.length}`,
      });
    }

    // "flaky:N:<CODE>" → fail the first N attempts, succeed after
    const flakyMatch = /^flaky:(\d+):(\w+)$/.exec(this.behavior);
    if (flakyMatch) {
      const failUntil = Number(flakyMatch[1]);
      const code = flakyMatch[2] as DispatcherErrorCode;
      if (ctx.attempt <= failUntil) {
        throw new AdapterError(code, {
          message: `test-double: flaky fail at attempt ${ctx.attempt}/${failUntil}`,
        });
      }
      // fall through to success
    }

    // Honor cancellation even on the fast path
    if (ctx.signal.aborted) {
      call.aborted = true;
      throw new Error("aborted");
    }

    const completed = this.now();
    return {
      dispatch_id: `dsp_${request.turn_id.slice(4)}${ctx.attempt}`.padEnd(20, "x").slice(0, 20),
      session_id: request.session_id,
      turn_id: request.turn_id,
      content_blocks: [{ type: "text", text: "hello from in-memory-test-adapter" }],
      tool_calls: [],
      usage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        cached_tokens: this.usage.cached_tokens,
      },
      stop_reason: "NaturalStop",
      dispatcher_error_code: null,
      latency_ms: Math.max(0, completed - started),
      provider_request_id: `test-req-${this.calls.length}`,
      provider: this.name,
      model_echo: request.model,
      billing_tag: request.billing_tag,
      correlation_id: request.correlation_id,
      generated_at: new Date(completed).toISOString(),
    };
  }
}
