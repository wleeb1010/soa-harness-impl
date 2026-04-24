/**
 * §16.6 Streaming Dispatcher — SSE framing + in-flight abort registry.
 *
 * This module is intentionally narrow-scoped. It owns:
 *   - `serializeSseFrame` — deterministic SSE wire serialization per §16.6.2
 *     (event: <type>\n data: <JCS(event)>\n\n)
 *   - `InFlightRegistry` — tracks AbortControllers for in-flight streaming
 *     dispatches so POST /dispatch/{correlation_id}/cancel can fire them
 *   - `runStreamDispatch` — orchestrates the SSE response: invokes the
 *     adapter's dispatchStream, serializes each event, enforces the §16.6.3
 *     sequence invariants, writes a dispatch audit row at termination
 *
 * The HTTP plugin layer (plugin.ts) handles auth, readiness, rate-limiting
 * and then hands off to this module.
 */

import type { FastifyReply } from "fastify";
import type { Dispatcher } from "./dispatcher.js";
import { AdapterError } from "./errors.js";
import type { ProviderAdapter } from "./adapter.js";
import type {
  DispatchRequest,
  DispatcherErrorCode,
  StreamedDispatchEvent,
} from "./types.js";

/**
 * Minimal JCS (RFC 8785) canonicalization for objects. The dispatcher stream
 * never contains floats or big numbers — safe integer-only JSON is sufficient.
 * Shared helper lives in @soa-harness/core but we avoid that import here to
 * keep the streaming hot path zero-dep.
 */
function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + jcs((v as Record<string, unknown>)[k])).join(",") +
    "}"
  );
}

/**
 * Serialize one StreamedDispatchEvent to a single SSE frame per §16.6.2.
 * Format: `event: <type>\ndata: <JCS(event)>\n\n`.
 */
export function serializeSseFrame(event: StreamedDispatchEvent): string {
  return `event: ${event.type}\ndata: ${jcs(event)}\n\n`;
}

/**
 * Tracks in-flight streaming dispatches keyed by correlation_id so the
 * cancellation endpoint can abort them.
 */
export class InFlightRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(correlationId: string): AbortController {
    const ctrl = new AbortController();
    this.controllers.set(correlationId, ctrl);
    return ctrl;
  }

  /** Returns true if a dispatch was found and the abort was fired. */
  cancel(correlationId: string): boolean {
    const ctrl = this.controllers.get(correlationId);
    if (ctrl === undefined) return false;
    ctrl.abort();
    return true;
  }

  release(correlationId: string): void {
    this.controllers.delete(correlationId);
  }

  has(correlationId: string): boolean {
    return this.controllers.has(correlationId);
  }

  size(): number {
    return this.controllers.size;
  }
}

export interface StreamDispatchOptions {
  request: DispatchRequest;
  dispatcher: Dispatcher;
  adapter: ProviderAdapter;
  reply: FastifyReply;
  inflight: InFlightRegistry;
}

/**
 * Validates the §16.6.3 sequence as events flow through. Throws on violation;
 * the caller maps the throw to DispatcherAdapterError per §16.6.1 abort
 * semantics.
 */
class SequenceChecker {
  private messageStarted = false;
  private messageEnded = false;
  private openBlockIndex: number | null = null;
  private lastSeq = -1;

  check(event: StreamedDispatchEvent): void {
    if (event.sequence <= this.lastSeq) {
      throw new Error(
        `sequence-non-monotonic: got ${event.sequence} after ${this.lastSeq}`,
      );
    }
    this.lastSeq = event.sequence;

    switch (event.type) {
      case "MessageStart":
        if (this.messageStarted) throw new Error("duplicate-MessageStart");
        this.messageStarted = true;
        break;
      case "ContentBlockStart":
        if (!this.messageStarted) throw new Error("ContentBlockStart-before-MessageStart");
        if (this.openBlockIndex !== null) {
          throw new Error(
            `ContentBlockStart-without-closing-prev-block-${this.openBlockIndex}`,
          );
        }
        this.openBlockIndex = event.content_block_index ?? 0;
        break;
      case "ContentBlockDelta":
        if (this.openBlockIndex === null) {
          throw new Error("ContentBlockDelta-outside-open-block");
        }
        break;
      case "ContentBlockEnd":
        if (this.openBlockIndex === null) {
          throw new Error("ContentBlockEnd-without-matching-Start");
        }
        this.openBlockIndex = null;
        break;
      case "MessageEnd":
        if (!this.messageStarted) throw new Error("MessageEnd-without-MessageStart");
        if (this.messageEnded) throw new Error("duplicate-MessageEnd");
        this.messageEnded = true;
        break;
    }
  }

  complete(): boolean {
    return this.messageStarted && this.messageEnded && this.openBlockIndex === null;
  }
}

/**
 * Runs one streaming dispatch end-to-end over the given Fastify reply.
 *
 * Caller responsibilities (plugin.ts):
 *   - Auth + rate-limiting + readiness gate
 *   - Schema validation of the request body
 *   - Session-bearer ownership check
 *
 * This function's responsibilities:
 *   - Set SSE response headers
 *   - Call `dispatcher.recordStreamStart()` so the audit row builder sees
 *     the dispatch (audit row is closed at stream termination)
 *   - Register an AbortController with InFlightRegistry
 *   - Iterate adapter.dispatchStream(), serializing each event as an SSE frame
 *   - Enforce §16.6.3 sequence invariants via SequenceChecker
 *   - On abort: stop forwarding deltas; the adapter is expected to close
 *     cleanly with ContentBlockEnd + MessageEnd
 *   - Emit `: stream-done\n\n` comment + close the connection
 *   - Record the dispatch audit row with final stop_reason
 */
export async function runStreamDispatch(opts: StreamDispatchOptions): Promise<void> {
  const { request, dispatcher, adapter, reply, inflight } = opts;

  if (adapter.dispatchStream === undefined) {
    // Caller should have checked this already — fail loudly if not.
    throw new Error("runStreamDispatch called against a sync-only adapter");
  }

  const ctrl = inflight.register(request.correlation_id);
  const raw = reply.raw;

  reply.hijack();
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });

  const checker = new SequenceChecker();
  let finalStopReason: StreamedDispatchEvent["stop_reason"] | undefined;
  let finalDispatcherErrorCode: DispatcherErrorCode | null = null;
  let finalUsage: StreamedDispatchEvent["usage"] | undefined;
  const dispatchStart = Date.now();

  try {
    const iter = adapter.dispatchStream(request, {
      signal: ctrl.signal,
      attempt: 1,
    });

    for await (const event of iter) {
      checker.check(event);
      raw.write(serializeSseFrame(event));
      if (event.type === "MessageEnd") {
        finalStopReason = event.stop_reason;
        finalDispatcherErrorCode = event.dispatcher_error_code ?? null;
        finalUsage = event.usage;
      }
    }

    if (!checker.complete()) {
      // Adapter broke the invariant — surface as DispatcherAdapterError.
      throw new Error("stream-terminated-mid-message");
    }
  } catch (err) {
    // Convert any mid-stream failure into a synthetic MessageEnd
    // (DispatcherError / DispatcherAdapterError / cancellation) then close.
    if (finalStopReason === undefined) {
      const code: DispatcherErrorCode =
        err instanceof AdapterError ? err.code : "DispatcherAdapterError";
      const syntheticEnd: StreamedDispatchEvent = {
        type: "MessageEnd",
        sequence: 999999, // high to preserve monotonicity
        emitted_at: new Date().toISOString(),
        stop_reason: "DispatcherError",
        dispatcher_error_code: code,
        correlation_id: request.correlation_id,
        session_id: request.session_id,
      };
      raw.write(serializeSseFrame(syntheticEnd));
      finalStopReason = "DispatcherError";
      finalDispatcherErrorCode = code;
    }
  } finally {
    raw.write(": stream-done\n\n");
    raw.end();
    inflight.release(request.correlation_id);

    // Record the one-row-per-dispatch audit entry on the dispatcher.
    dispatcher.recordStreamDispatch({
      request,
      stop_reason: finalStopReason ?? "NaturalStop",
      dispatcher_error_code: finalDispatcherErrorCode,
      usage: finalUsage ?? { input_tokens: 0, output_tokens: 0 },
      started_at: new Date(dispatchStart).toISOString(),
      completed_at: new Date().toISOString(),
    });
  }
}
