/**
 * RunnerClient — unit tests. Mocks fetch() and verifies the wrapper's
 * auth-header plumbing, error mapping, and SSE parser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunnerClient } from "../src/client.js";
import type { DispatchRequest } from "@soa-harness/runner";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

const baseReq: DispatchRequest = {
  session_id: "ses_" + "a".repeat(20),
  turn_id: "trn_" + "b".repeat(20),
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  budget_ceiling_tokens: 1000,
  billing_tag: "tenant-a/env-test",
  correlation_id: "cor_" + "c".repeat(20),
  idempotency_key: "idem_" + "d".repeat(20),
};

describe("RunnerClient", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("getHealth() hits /health without auth and returns parsed JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "alive", soaHarnessVersion: "1.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new RunnerClient({ runnerUrl: "http://x" });
    const h = await client.getHealth();
    expect(h.status).toBe("alive");
    expect(h.soaHarnessVersion).toBe("1.0");
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://x/health");
    expect(call[1].headers.Authorization).toBeUndefined();
  });

  it("getAuditTail() requires bearer, hits /audit/tail with Authorization header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ records: [{ timestamp: "2026-04-24T00:00:00Z" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const noBearer = new RunnerClient({ runnerUrl: "http://x" });
    await expect(noBearer.getAuditTail(5)).rejects.toThrow(/requires.*bearer/i);

    const withBearer = new RunnerClient({ runnerUrl: "http://x", sessionBearer: "tok" });
    const r = await withBearer.getAuditTail(5);
    expect(r.records?.length).toBe(1);
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://x/audit/tail?limit=5");
    expect(call[1].headers.Authorization).toBe("Bearer tok");
  });

  it("non-2xx response maps to thrown Error with status + body preview", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("upstream down", { status: 503 }),
    );
    const client = new RunnerClient({ runnerUrl: "http://x" });
    await expect(client.getHealth()).rejects.toThrow(/503/);
  });

  it("dispatchStream() parses SSE frames and yields StreamedDispatchEvent", async () => {
    const body = sseBody([
      `event: MessageStart\ndata: ${JSON.stringify({ type: "MessageStart", sequence: 0, correlation_id: baseReq.correlation_id, session_id: baseReq.session_id })}\n\n`,
      `event: ContentBlockDelta\ndata: ${JSON.stringify({ type: "ContentBlockDelta", sequence: 1, delta: { text: "hi" }, correlation_id: baseReq.correlation_id, session_id: baseReq.session_id })}\n\n`,
      `event: MessageEnd\ndata: ${JSON.stringify({ type: "MessageEnd", sequence: 2, stop_reason: "NaturalStop", correlation_id: baseReq.correlation_id, session_id: baseReq.session_id })}\n\n`,
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const client = new RunnerClient({ runnerUrl: "http://x", sessionBearer: "tok" });
    const events = [];
    for await (const e of client.dispatchStream(baseReq)) events.push(e);
    expect(events.length).toBe(3);
    expect(events[0]?.type).toBe("MessageStart");
    expect(events[1]?.type).toBe("ContentBlockDelta");
    expect(events[2]?.type).toBe("MessageEnd");
    expect(events[2]?.stop_reason).toBe("NaturalStop");
  });
});
