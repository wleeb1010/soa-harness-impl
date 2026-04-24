import { describe, it, expect, vi } from "vitest";
import { AdapterError } from "@soa-harness/runner";
import type { DispatchRequest } from "@soa-harness/runner";
import { ExampleProviderAdapter, type FetchLike } from "../src/index.js";

function validRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    session_id: "ses_" + "a".repeat(20),
    turn_id: "trn_" + "b".repeat(20),
    model: "gpt-4-test",
    messages: [{ role: "user", content: "hello" }],
    budget_ceiling_tokens: 10_000,
    billing_tag: "tenant-a/env-test",
    correlation_id: "cor_" + "c".repeat(20),
    idempotency_key: "idem-" + "d".repeat(20),
    stream: false,
    ...overrides,
  };
}

function fakeOkFetch(body: object): FetchLike {
  return async (_url, _init) => new Response(JSON.stringify(body), { status: 200 });
}

function fakeStatusFetch(status: number, headers: Record<string, string> = {}): FetchLike {
  return async (_url, _init) => new Response(JSON.stringify({ error: "fake" }), { status, headers });
}

describe("ExampleProviderAdapter — happy path", () => {
  it("returns a DispatchResponse that echoes request fields", async () => {
    const adapter = new ExampleProviderAdapter({
      baseUrl: "http://fake/v1",
      apiKey: "test-key",
      fetchFn: fakeOkFetch({
        id: "fake-resp-123",
        choices: [{ message: { role: "assistant", content: "hi back" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, cached_tokens: 0 },
      }),
    });
    const req = validRequest();
    const res = await adapter.dispatch(req, { signal: new AbortController().signal, attempt: 1 });
    expect(res.stop_reason).toBe("NaturalStop");
    expect(res.session_id).toBe(req.session_id);
    expect(res.turn_id).toBe(req.turn_id);
    expect(res.billing_tag).toBe(req.billing_tag);
    expect(res.correlation_id).toBe(req.correlation_id);
    expect(res.provider).toBe("example-provider");
    expect(res.model_echo).toBe("gpt-4-test");
    expect(res.usage.input_tokens).toBe(10);
    expect(res.usage.output_tokens).toBe(4);
    expect(res.content_blocks).toHaveLength(1);
    expect(res.dispatch_id.startsWith("dsp_")).toBe(true);
    expect(res.dispatch_id.length).toBeGreaterThanOrEqual(20);
  });

  it("sets Authorization + Content-Type headers", async () => {
    const seenInit = vi.fn<FetchLike>();
    seenInit.mockImplementation(async (_url, _init) => new Response(JSON.stringify({ id: "x", choices: [{ message: { content: "" } }], usage: {} }), { status: 200 }));
    const adapter = new ExampleProviderAdapter({
      baseUrl: "http://fake/v1",
      apiKey: "my-token",
      fetchFn: seenInit,
    });
    await adapter.dispatch(validRequest(), { signal: new AbortController().signal, attempt: 1 });
    const call = seenInit.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("http://fake/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("ExampleProviderAdapter — error classification (§16.3.1)", () => {
  const cases: Array<{ status: number; code: string; retryAfter?: string }> = [
    { status: 429, code: "ProviderRateLimited", retryAfter: "2" },
    { status: 401, code: "ProviderAuthFailed" },
    { status: 403, code: "ProviderAuthFailed" },
    { status: 500, code: "ProviderUnavailable" },
    { status: 502, code: "ProviderUnavailable" },
    { status: 503, code: "ProviderUnavailable" },
    { status: 400, code: "ContextLengthExceeded" },
    { status: 418, code: "ProviderNetworkFailed" },
  ];

  for (const c of cases) {
    it(`HTTP ${c.status} → ${c.code}`, async () => {
      const headers = c.retryAfter ? { "retry-after": c.retryAfter } : {};
      const adapter = new ExampleProviderAdapter({
        baseUrl: "http://fake/v1",
        apiKey: "t",
        fetchFn: fakeStatusFetch(c.status, headers),
      });
      await expect(adapter.dispatch(validRequest(), { signal: new AbortController().signal, attempt: 1 }))
        .rejects
        .toThrowError(AdapterError);
      try {
        await adapter.dispatch(validRequest(), { signal: new AbortController().signal, attempt: 1 });
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe(c.code);
        if (c.retryAfter) {
          expect((err as AdapterError).retryAfterMs).toBe(Number(c.retryAfter) * 1000);
        }
      }
    });
  }
});

describe("ExampleProviderAdapter — abort signal propagation", () => {
  it("pre-aborted signal causes the adapter to reject promptly", async () => {
    const adapter = new ExampleProviderAdapter({
      baseUrl: "http://fake/v1",
      apiKey: "t",
      fetchFn: async (_url, init) => {
        // If the signal is already aborted when fetch is called, reject.
        if ((init.signal as AbortSignal)?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return new Response(JSON.stringify({ id: "x", choices: [], usage: {} }), { status: 200 });
      },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(adapter.dispatch(validRequest(), { signal: ctrl.signal, attempt: 1 })).rejects.toThrow();
  });

  it("mid-flight abort propagates", async () => {
    const adapter = new ExampleProviderAdapter({
      baseUrl: "http://fake/v1",
      apiKey: "t",
      fetchFn: async (_url, init) => {
        // Simulate a stalled provider
        return new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal)?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });
    const ctrl = new AbortController();
    const pending = adapter.dispatch(validRequest(), { signal: ctrl.signal, attempt: 1 });
    setTimeout(() => ctrl.abort(), 5);
    await expect(pending).rejects.toThrow();
  });
});

describe("ExampleProviderAdapter — constructor validation", () => {
  it("throws when baseUrl is missing", () => {
    expect(() => new ExampleProviderAdapter({ baseUrl: "", apiKey: "t" })).toThrow();
  });
  it("throws when apiKey is missing", () => {
    expect(() => new ExampleProviderAdapter({ baseUrl: "http://fake", apiKey: "" })).toThrow();
  });
  it("strips trailing slashes from baseUrl", async () => {
    const seen = vi.fn<FetchLike>();
    seen.mockImplementation(async (_url, _init) => new Response(JSON.stringify({ id: "x", choices: [], usage: {} }), { status: 200 }));
    const adapter = new ExampleProviderAdapter({
      baseUrl: "http://fake/v1///",
      apiKey: "t",
      fetchFn: seen,
    });
    await adapter.dispatch(validRequest(), { signal: new AbortController().signal, attempt: 1 });
    expect(seen.mock.calls[0]![0]).toBe("http://fake/v1/chat/completions");
  });
});
