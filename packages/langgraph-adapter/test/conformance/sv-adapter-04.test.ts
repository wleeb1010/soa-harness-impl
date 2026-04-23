/**
 * SV-ADAPTER-04 — AuditForwarding.
 *
 * Asserts that tool-invocation audit rows forwarded through the adapter
 * (a) carry retention_class stamped per §10.5.6, (b) reach the Runner's
 * audit endpoint with the expected payload shape, and (c) return a
 * Runner-authoritative record_id + hash-chain identity.
 *
 * Chain-linkage verification itself is Runner-side (the adapter doesn't
 * compute prev_hash / this_hash); we assert the adapter correctly
 * propagates the Runner's response.
 */

import { describe, it, expect } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createLangGraphAdapter,
  ADAPTER_VERSION,
  AuditSinkForwardError,
  type ToolInvocationAuditInput,
} from "../../src/index.js";

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

const BASE_CARD = { soaHarnessVersion: "1.0", name: "x", version: "1.0.0" };

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

function buildAdapter(opts: { activeMode: string; auditFetch: typeof fetch }) {
  const echoTool = tool(async () => "ok", {
    name: "echo",
    schema: z.object({ input: z.string() }),
    description: "fixture",
  });
  return createLangGraphAdapter({
    tools: [echoTool],
    permission: {
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
    },
    audit: {
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: opts.activeMode,
      fetchImpl: opts.auditFetch,
    },
    card: { baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION },
  });
}

describe("SV-ADAPTER-04 — AuditForwarding (§18.5.3 + §10.5.6)", () => {
  it("tool-invocation record lands at the Runner with retention_class stamped (standard)", async () => {
    let capturedBody: unknown = null;
    const adapter = buildAdapter({
      activeMode: "ReadOnly",
      auditFetch: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, {
          record_id: "aud_xyz",
          this_hash: "a".repeat(64),
          prev_hash: "0".repeat(64),
          sink_timestamp: "2026-04-22T20:00:00Z",
          retention_class: "standard-90d",
        });
      }),
    });

    const resp = await adapter.auditSink.append(sampleRecord());
    expect(resp.record_id).toBe("aud_xyz");
    expect(resp.retention_class).toBe("standard-90d");
    expect((capturedBody as { retention_class: string }).retention_class).toBe("standard-90d");
  });

  it("DangerFullAccess activeMode → retention_class=\"dfa-365d\" on forwarded row", async () => {
    let capturedBody: unknown = null;
    const adapter = buildAdapter({
      activeMode: "DangerFullAccess",
      auditFetch: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, {
          record_id: "aud_dfa",
          this_hash: "d".repeat(64),
          prev_hash: "0".repeat(64),
          sink_timestamp: "2026-04-22T20:00:00Z",
          retention_class: "dfa-365d",
        });
      }),
    });

    const resp = await adapter.auditSink.append(sampleRecord());
    expect(resp.retention_class).toBe("dfa-365d");
    expect((capturedBody as { retention_class: string }).retention_class).toBe("dfa-365d");
  });

  it("chain-identity fields (record_id, this_hash, prev_hash, sink_timestamp) are surfaced", async () => {
    const adapter = buildAdapter({
      activeMode: "Standard",
      auditFetch: mockFetch(() =>
        jsonResponse(201, {
          record_id: "aud_abc",
          this_hash: "c".repeat(64),
          prev_hash: "b".repeat(64),
          sink_timestamp: "2026-04-22T20:01:02.345Z",
          retention_class: "standard-90d",
        }),
      ),
    });
    const resp = await adapter.auditSink.append(sampleRecord());
    expect(resp).toMatchObject({
      record_id: "aud_abc",
      this_hash: "c".repeat(64),
      prev_hash: "b".repeat(64),
      sink_timestamp: "2026-04-22T20:01:02.345Z",
      retention_class: "standard-90d",
    });
  });

  it("Runner-side 4xx surfaces as AuditSinkForwardError with status (orchestrator retry point)", async () => {
    const adapter = buildAdapter({
      activeMode: "Standard",
      auditFetch: mockFetch(() => jsonResponse(400, { error: "bad-request" })),
    });
    await expect(adapter.auditSink.append(sampleRecord())).rejects.toThrow(AuditSinkForwardError);
  });

  it("failed error branch includes ok=false + error_code on the forwarded row", async () => {
    let capturedBody: unknown = null;
    const adapter = buildAdapter({
      activeMode: "ReadOnly",
      auditFetch: mockFetch((_url, init) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, {
          record_id: "aud_err",
          this_hash: "e".repeat(64),
          prev_hash: "0".repeat(64),
          sink_timestamp: "2026-04-22T20:00:00Z",
          retention_class: "standard-90d",
        });
      }),
    });

    await adapter.auditSink.append(
      sampleRecord({ ok: false, error_code: "ToolError", output_digest: "d".repeat(64) }),
    );
    const body = capturedBody as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("ToolError");
    expect(body.output_digest).toBe("d".repeat(64));
  });
});
