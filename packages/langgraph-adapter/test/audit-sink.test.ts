/**
 * Audit-sink forwarder tests — Phase 2 module B.
 *
 * Covers the retention_class derivation invariant, HTTP contract, and
 * error-path behavior. Unlike the permission hook, the audit-sink is a
 * write path that MUST NOT swallow errors — we assert AuditSinkForwardError
 * is thrown on every non-success branch so the orchestrator has a
 * signal to buffer + retry.
 */

import { describe, it, expect } from "vitest";
import {
  RunnerAuditSinkForwarder,
  createRunnerAuditSinkForwarder,
  deriveRetentionClass,
  AuditSinkForwardError,
  type ToolInvocationAuditInput,
} from "../src/audit-sink.js";

type FetchArgs = Parameters<typeof fetch>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (...args: FetchArgs) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_APPEND_OK = {
  record_id: "aud_abc123",
  this_hash: "c".repeat(64),
  prev_hash: "b".repeat(64),
  sink_timestamp: "2026-04-22T20:00:00Z",
  retention_class: "standard-90d",
};

function sampleRecord(overrides: Partial<ToolInvocationAuditInput> = {}): ToolInvocationAuditInput {
  return {
    session_id: "ses_1",
    tool_call_id: "tcl_1",
    tool_name: "echo",
    args_digest: "a".repeat(64),
    ok: true,
    observed_at: "2026-04-22T20:00:00Z",
    ...overrides,
  };
}

describe("deriveRetentionClass — §10.5.6", () => {
  it("DangerFullAccess → dfa-365d", () => {
    expect(deriveRetentionClass("DangerFullAccess")).toBe("dfa-365d");
  });

  it("every other activeMode → standard-90d", () => {
    for (const mode of ["ReadOnly", "WorkspaceWrite", "Standard", "", "unknown"]) {
      expect(deriveRetentionClass(mode)).toBe("standard-90d");
    }
  });
});

describe("RunnerAuditSinkForwarder — HTTP append", () => {
  it("happy path — posts record + returns chain identity", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "bearer-abc",
      activeMode: "WorkspaceWrite",
      fetchImpl: mockFetch((url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, SAMPLE_APPEND_OK);
      }),
    });

    const resp = await sink.append(sampleRecord());
    expect(resp.record_id).toBe("aud_abc123");
    expect(capturedUrl).toBe("http://localhost:7700/audit/tool-invocations");
    expect(capturedBody).toMatchObject({
      session_id: "ses_1",
      tool_name: "echo",
      retention_class: "standard-90d",
    });
  });

  it("stamps retention_class dfa-365d when activeMode=DangerFullAccess", async () => {
    let capturedBody: unknown = null;
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "DangerFullAccess",
      fetchImpl: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, { ...SAMPLE_APPEND_OK, retention_class: "dfa-365d" });
      }),
    });
    await sink.append(sampleRecord());
    expect((capturedBody as { retention_class: string }).retention_class).toBe("dfa-365d");
  });

  it("honors endpointPath override", async () => {
    let capturedUrl = "";
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700/",
      endpointPath: "/custom/audit-path",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch((url) => {
        capturedUrl = url;
        return jsonResponse(201, SAMPLE_APPEND_OK);
      }),
    });
    await sink.append(sampleRecord());
    expect(capturedUrl).toBe("http://localhost:7700/custom/audit-path");
  });

  it("4xx → throws AuditSinkForwardError with status", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => jsonResponse(400, { error: "bad-request" })),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(AuditSinkForwardError);
    await expect(sink.append(sampleRecord())).rejects.toMatchObject({ status: 400 });
  });

  it("5xx → throws AuditSinkForwardError with status", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => jsonResponse(503, { error: "not-ready" })),
    });
    await expect(sink.append(sampleRecord())).rejects.toMatchObject({ status: 503 });
  });

  it("malformed JSON body → throws AuditSinkForwardError", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(
        () => new Response("<html>oops</html>", { status: 201 }),
      ),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(/malformed JSON/);
  });

  it("response missing required chain-identity fields → throws", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => jsonResponse(201, { record_id: "aud_x" })),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(/missing required fields/);
  });

  it("network error (fetch throws) → throws AuditSinkForwardError with cause", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(AuditSinkForwardError);
  });

  it("request timeout → throws AuditSinkForwardError", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      timeoutMs: 50,
      fetchImpl: mockFetch(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(AuditSinkForwardError);
  });

  it("empty bearer → throws AuditSinkForwardError without making a request", async () => {
    let fetchCalled = false;
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => {
        fetchCalled = true;
        return jsonResponse(201, SAMPLE_APPEND_OK);
      }),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(/bearer is empty/);
    expect(fetchCalled).toBe(false);
  });

  it("failing bearer provider → throws AuditSinkForwardError with cause", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: async () => {
        throw new Error("token lookup failed");
      },
      activeMode: "Standard",
      fetchImpl: mockFetch(() => jsonResponse(201, SAMPLE_APPEND_OK)),
    });
    await expect(sink.append(sampleRecord())).rejects.toThrow(/bearer provider threw/);
  });

  it("passes Bearer header + content-type header", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "bearer-xyz",
      activeMode: "Standard",
      fetchImpl: mockFetch((_url, init) => {
        const h = init.headers as Record<string, string>;
        expect(h["authorization"]).toBe("Bearer bearer-xyz");
        expect(h["content-type"]).toBe("application/json");
        return jsonResponse(201, SAMPLE_APPEND_OK);
      }),
    });
    await sink.append(sampleRecord());
  });

  it("forwards optional output_digest + error_code when set", async () => {
    let capturedBody: unknown = null;
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, SAMPLE_APPEND_OK);
      }),
    });
    await sink.append(
      sampleRecord({ output_digest: "d".repeat(64), ok: false, error_code: "ToolError" }),
    );
    const body = capturedBody as Record<string, string>;
    expect(body.output_digest).toBe("d".repeat(64));
    expect(body.error_code).toBe("ToolError");
    expect(body.ok).toBe(false);
  });

  it("factory is equivalent to constructor", async () => {
    const sink = createRunnerAuditSinkForwarder({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "Standard",
      fetchImpl: mockFetch(() => jsonResponse(201, SAMPLE_APPEND_OK)),
    });
    const resp = await sink.append(sampleRecord());
    expect(resp.record_id).toBe("aud_abc123");
  });

  it("rejects construction without required fields", () => {
    expect(
      () =>
        new RunnerAuditSinkForwarder({
          runnerBaseUrl: "",
          bearer: "b",
          activeMode: "Standard",
        }),
    ).toThrow(/runnerBaseUrl is required/);
    expect(
      () =>
        new RunnerAuditSinkForwarder({
          runnerBaseUrl: "http://x",
          bearer: "b",
          activeMode: "",
        }),
    ).toThrow(/activeMode is required/);
  });
});
