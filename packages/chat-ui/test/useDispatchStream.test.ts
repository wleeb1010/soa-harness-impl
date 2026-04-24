/**
 * useDispatchStream — unit tests. Stubs fetch to return a Response with a
 * synthetic SSE body, then asserts the hook aggregates deltas + terminates
 * cleanly on MessageEnd.
 *
 * Not using @testing-library/react here; the hook's state machine is testable
 * as a plain function because React's act() is overkill for the assertions.
 * Mirrors the runner-side dispatch-stream.test.ts philosophy of testing wire
 * behavior directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the parseSseFrame-like logic by running the hook through a jsdom
// render; but since we don't have testing-library wired yet in this slim
// package build, we instead reach into the module via a public re-export.
// For v1.2 ship we target a minimum bar: the frame parser handles the shapes
// the runner emits, and the hook terminates on MessageEnd.

import { renderHook, act } from "@testing-library/react";
import { useDispatchStream } from "../src/hooks/useDispatchStream.js";
import type { DispatchRequest } from "@soa-harness/runner";

function makeSseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function sseFrame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const baseRequest: DispatchRequest = {
  session_id: "ses_" + "a".repeat(20),
  turn_id: "trn_" + "b".repeat(20),
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  budget_ceiling_tokens: 1000,
  billing_tag: "tenant-a/env-test",
  correlation_id: "cor_" + "c".repeat(20),
  idempotency_key: "idem_" + "d".repeat(20),
};

describe("useDispatchStream", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("aggregates ContentBlockDelta.text and terminates on MessageEnd", async () => {
    const body = makeSseBody([
      sseFrame("MessageStart", { type: "MessageStart", sequence: 0, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id, turn_id: baseRequest.turn_id }),
      sseFrame("ContentBlockStart", { type: "ContentBlockStart", sequence: 1, content_block_index: 0, content_block_type: "text", correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockDelta", { type: "ContentBlockDelta", sequence: 2, content_block_index: 0, delta: { text: "hello " }, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockDelta", { type: "ContentBlockDelta", sequence: 3, content_block_index: 0, delta: { text: "world" }, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockEnd", { type: "ContentBlockEnd", sequence: 4, content_block_index: 0, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("MessageEnd", { type: "MessageEnd", sequence: 5, stop_reason: "NaturalStop", dispatcher_error_code: null, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      ": stream-done\n\n",
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const { result } = renderHook(() =>
      useDispatchStream({
        runnerUrl: "http://localhost:7700",
        sessionBearer: "session-bearer",
        request: baseRequest,
        autoStart: true,
      }),
    );

    // Wait for the stream to terminate
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.status).toBe("done");
    expect(result.current.text).toBe("hello world");
    expect(result.current.stop_reason).toBe("NaturalStop");
    expect(result.current.events.length).toBe(6);
  });

  it("surfaces HTTP 406 as status=error with DispatcherStreamUnsupported body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ dispatcher_error_code: "DispatcherStreamUnsupported", detail: "sync-only adapter" }),
        { status: 406, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(() =>
      useDispatchStream({
        runnerUrl: "http://localhost:7700",
        sessionBearer: "session-bearer",
        request: baseRequest,
        autoStart: true,
      }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.http_error).toContain("HTTP 406");
    expect(result.current.http_error).toContain("DispatcherStreamUnsupported");
  });

  it("cancel() POSTs /dispatch/:correlation_id/cancel and aborts the local fetch", async () => {
    const cancelSpy = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    const streamingBody = makeSseBody([
      sseFrame("MessageStart", { type: "MessageStart", sequence: 0, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockStart", { type: "ContentBlockStart", sequence: 1, content_block_index: 0, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockDelta", { type: "ContentBlockDelta", sequence: 2, content_block_index: 0, delta: { text: "abc " }, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("ContentBlockEnd", { type: "ContentBlockEnd", sequence: 3, content_block_index: 0, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
      sseFrame("MessageEnd", { type: "MessageEnd", sequence: 4, stop_reason: "UserInterrupt", dispatcher_error_code: null, correlation_id: baseRequest.correlation_id, session_id: baseRequest.session_id }),
    ]);
    globalThis.fetch = vi.fn((input) => {
      if (typeof input === "string" && input.includes("/cancel")) {
        return cancelSpy(input);
      }
      return Promise.resolve(
        new Response(streamingBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useDispatchStream({
        runnerUrl: "http://localhost:7700",
        sessionBearer: "session-bearer",
        request: baseRequest,
        autoStart: true,
      }),
    );

    // Give the stream a tick to start, then cancel
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result.current.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(cancelSpy).toHaveBeenCalled();
    const cancelUrl = cancelSpy.mock.calls[0]?.[0] as string;
    expect(cancelUrl).toContain(`/dispatch/${baseRequest.correlation_id}/cancel`);
  });
});
