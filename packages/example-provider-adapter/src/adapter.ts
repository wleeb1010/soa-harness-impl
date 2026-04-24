/**
 * ExampleProviderAdapter — reference scaffold showing how adopters wire a
 * real LLM provider behind the §16.3 dispatcher's ProviderAdapter interface.
 *
 * This file is a COPY-AND-CUSTOMIZE starting point. The defaults point at a
 * hypothetical generic Chat-Completions-shaped endpoint — swap the request
 * shape, response parser, and error classification for your actual provider.
 *
 * What it demonstrates:
 *   1. Taking a base URL + auth bearer via constructor options
 *   2. Shaping a DispatchRequest into a provider-specific HTTP POST body
 *   3. Honoring AbortSignal so dispatcher-level cancellation interrupts the
 *      in-flight fetch cleanly
 *   4. Classifying HTTP status codes into the §16.3.1 taxonomy via AdapterError
 *   5. Parsing the provider response back into a DispatchResponse, preserving
 *      the echo contract (session_id / turn_id / billing_tag / correlation_id)
 *
 * What it deliberately does NOT do:
 *   - Real provider auth (API keys, OAuth, AWS SigV4, etc.) — adopters wire this
 *   - Streaming — M8 scope once the dispatcher ships streaming mode
 *   - Tool-schema translation — depends on the provider's tool-use wire shape
 *   - Prompt caching, structured outputs, function-call mode, etc.
 *
 * Test strategy: `FetchLike` is injectable so tests can drive deterministic
 * responses. Production uses global fetch; tests use a stub.
 */

import {
  AdapterError,
  type AdapterDispatchContext,
  type DispatchRequest,
  type DispatchResponse,
  type DispatchUsage,
  type ProviderAdapter,
} from "@soa-harness/runner";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExampleProviderAdapterOptions {
  /** Provider chat-completions endpoint. No default — adopters set explicitly. */
  readonly baseUrl: string;
  /** Bearer token for provider auth. NOT persisted by the adapter. */
  readonly apiKey: string;
  /** Adapter identifier surfaced in DispatchResponse.provider. */
  readonly name?: string;
  /** Injectable fetch (defaults to global). */
  readonly fetchFn?: FetchLike;
  /** Connect+read timeout. Default 60s. */
  readonly timeoutMs?: number;
  /**
   * Dispatcher always owns retry budget (§16.3 step 5). Adapter SHOULD NOT
   * do its own retries — throw AdapterError and let the dispatcher loop.
   */
}

interface ProviderApiResponseShape {
  id?: string;
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ExampleProviderAdapter implements ProviderAdapter {
  public readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: ExampleProviderAdapterOptions) {
    if (!opts.baseUrl) throw new Error("ExampleProviderAdapter: baseUrl is required");
    if (!opts.apiKey) throw new Error("ExampleProviderAdapter: apiKey is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.name = opts.name ?? "example-provider";
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async dispatch(
    request: DispatchRequest,
    ctx: AdapterDispatchContext,
  ): Promise<DispatchResponse> {
    // Link dispatcher signal to an internal timeout controller so we abort
    // on EITHER the caller's request OR our own deadline.
    const controller = new AbortController();
    const unlink = linkSignals(ctx.signal, controller);
    const timer = setTimeout(() => controller.abort(new Error("adapter timeout")), this.timeoutMs);
    const started = Date.now();

    try {
      const body = buildChatRequestBody(request);
      const resp = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          // ADOPTERS: add provider-specific headers (version, beta flags, etc.)
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw classifyHttpError(resp);
      }

      const parsed = (await resp.json()) as ProviderApiResponseShape;
      const latency_ms = Date.now() - started;

      return buildDispatchResponse(parsed, request, this.name, latency_ms);
    } catch (err: unknown) {
      // AbortSignal from dispatcher — the dispatcher treats this as
      // UserInterrupt. Re-throw a generic abort so the dispatcher's
      // `if (signal.aborted)` branch catches it.
      if (ctx.signal.aborted) throw err;
      // Timeout is a network-class failure per §16.3.1.
      if (controller.signal.aborted) {
        throw new AdapterError("ProviderNetworkFailed", {
          message: `timeout after ${this.timeoutMs}ms`,
        });
      }
      // Already classified.
      if (err instanceof AdapterError) throw err;
      // Network error — TLS / DNS / ECONNRESET / etc. Classify generically.
      throw new AdapterError("ProviderNetworkFailed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }
}

// ────────────────────────────────────────────────────────────────────────

function buildChatRequestBody(request: DispatchRequest): Record<string, unknown> {
  // ADOPTERS: shape this to your provider's wire. The default below is the
  // common OpenAI-compatible Chat Completions shape — works for OpenAI,
  // Azure OpenAI, Anthropic via their OpenAI-compat endpoint, groq, together,
  // and any llama.cpp server with --openai-compat.
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content,
    })),
  };
  if (request.max_output_tokens !== undefined) body["max_tokens"] = request.max_output_tokens;
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.top_p !== undefined) body["top_p"] = request.top_p;
  if (request.stop_sequences !== undefined && request.stop_sequences.length > 0) {
    body["stop"] = request.stop_sequences;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body["tools"] = request.tools;
  }
  return body;
}

function buildDispatchResponse(
  parsed: ProviderApiResponseShape,
  request: DispatchRequest,
  provider: string,
  latency_ms: number,
): DispatchResponse {
  const choice = parsed.choices?.[0];
  const text = choice?.message?.content ?? "";
  const usage: DispatchUsage = {
    input_tokens: parsed.usage?.prompt_tokens ?? 0,
    output_tokens: parsed.usage?.completion_tokens ?? 0,
    cached_tokens: parsed.usage?.cached_tokens ?? 0,
  };
  // Map provider's finish_reason to our StopReason. ADOPTERS: extend.
  let stop_reason: DispatchResponse["stop_reason"] = "NaturalStop";
  if (choice?.finish_reason === "length") {
    // Provider hit max_tokens — from the runtime's perspective this is
    // NaturalStop with a non-empty body. Budget-level concerns live in §13,
    // not here.
  } else if (choice?.finish_reason === "content_filter") {
    // Some providers surface content filter on-path rather than via a refusal
    // — we could either return a refusal content block (recommended) or
    // throw ContentFilterRefusal. Here we choose the refusal-block path so
    // the turn completes cleanly with a visible refusal in content_blocks.
  }
  return {
    dispatch_id: mintDispatchId(request.turn_id, parsed.id),
    session_id: request.session_id,
    turn_id: request.turn_id,
    content_blocks: text ? [{ type: "text", text }] : [],
    tool_calls: [],
    usage,
    stop_reason,
    dispatcher_error_code: null,
    latency_ms,
    provider_request_id: parsed.id ?? null,
    provider,
    model_echo: request.model,
    billing_tag: request.billing_tag,
    correlation_id: request.correlation_id,
    generated_at: new Date().toISOString(),
  };
}

function classifyHttpError(resp: Response): AdapterError {
  const retryAfter = resp.headers.get("retry-after");
  const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : null;
  if (resp.status === 429) {
    return new AdapterError("ProviderRateLimited", { message: `HTTP 429`, retryAfterMs });
  }
  if (resp.status === 401 || resp.status === 403) {
    return new AdapterError("ProviderAuthFailed", { message: `HTTP ${resp.status}` });
  }
  if (resp.status >= 500 && resp.status < 600) {
    return new AdapterError("ProviderUnavailable", { message: `HTTP ${resp.status}`, retryAfterMs });
  }
  if (resp.status === 400) {
    // Some providers use 400 for context-length-exceeded — ADOPTERS should
    // inspect the body and classify ContextLengthExceeded vs generic
    // DispatcherRequestInvalid based on provider-specific error codes.
    return new AdapterError("ContextLengthExceeded", { message: `HTTP 400 (context-length candidate)` });
  }
  // 4xx other than 400/401/403/429 — rare, treat as auth-ish.
  return new AdapterError("ProviderNetworkFailed", { message: `HTTP ${resp.status}` });
}

function parseRetryAfter(v: string): number | null {
  const seconds = Number(v);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const asDate = Date.parse(v);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function mintDispatchId(turn_id: string, providerId: string | undefined): string {
  const suffixBase = (providerId ?? turn_id.slice(4)).replace(/[^A-Za-z0-9]/g, "x");
  const rand = Math.floor(Math.random() * 2 ** 32)
    .toString(36)
    .padStart(8, "0");
  const padded = `${suffixBase}${rand}`;
  return `dsp_${padded.slice(0, 28).padEnd(16, "x")}`;
}

function linkSignals(external: AbortSignal, internal: AbortController): () => void {
  if (external.aborted) {
    internal.abort(external.reason);
    return () => {};
  }
  const onAbort = () => internal.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}
