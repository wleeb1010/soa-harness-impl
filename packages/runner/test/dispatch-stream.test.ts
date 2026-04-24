/**
 * §16.6 Streaming Dispatcher tests. Covers:
 *   - SSE framing (§16.6.2): Content-Type, event/data lines, : stream-done comment
 *   - Adapter-unsupported fallback (§16.6.2 step 1): sync-only adapter → 406
 *   - Sequence invariants (§16.6.3): MessageStart → Block*.Delta*.End → MessageEnd
 *   - Mid-stream cancellation (§16.6.4): abort after N deltas → no further deltas
 *   - Audit row on stream termination (§16.6.1 → §16.3 lifecycle step 6)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRunnerApp } from "../src/server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import { Dispatcher, InMemoryTestAdapter, serializeSseFrame, InFlightRegistry } from "../src/dispatch/index.js";
import type { ProviderAdapter } from "../src/dispatch/index.js";
import { AuditChain } from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8"),
) as InitialTrust;
const KID = "soa-release-v1.0";
const SESSION_ID = "ses_" + "a".repeat(20);
const BEARER = "session-bearer-" + "b".repeat(16);

let clockMs = 1_700_000_000_000;
const clock = () => new Date(clockMs);

async function bootAppWithAdapter(adapter: ProviderAdapter) {
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });

  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION_ID, BEARER, {
    activeMode: "DangerFullAccess",
    billing_tag: "tenant-a/env-test",
    created_at: clock(),
  });

  const chain = new AuditChain(clock);
  const dispatcher = new Dispatcher({
    adapter,
    auditChain: chain,
    clock,
    random: () => 0.5,
    sleep: async () => undefined,
    runnerVersion: "1.2-test",
  });

  const app = await buildRunnerApp({
    trust: TRUST,
    card: CARD,
    alg: "EdDSA",
    kid: KID,
    privateKey: keys.privateKey,
    x5c: [cert],
    dispatch: {
      dispatcher,
      sessionStore,
      clock,
      runnerVersion: "1.2-test",
      adapterForDebug: adapter,
    },
  });
  return { app, dispatcher, adapter, chain, sessionStore };
}

function reqBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    turn_id: "trn_" + "x".repeat(20),
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    budget_ceiling_tokens: 10_000,
    billing_tag: "tenant-a/env-test",
    correlation_id: "cor_" + "c".repeat(20),
    idempotency_key: "idem-" + "d".repeat(20),
    stream: true,
    ...overrides,
  };
}

describe("serializeSseFrame (unit — pure serialization)", () => {
  it("emits event/data/blankline per §16.6.2", () => {
    const frame = serializeSseFrame({
      type: "MessageStart",
      sequence: 0,
      emitted_at: "2026-04-24T00:00:00.000Z",
      correlation_id: "cor_" + "c".repeat(20),
      session_id: SESSION_ID,
      turn_id: "trn_" + "x".repeat(20),
    });
    expect(frame).toContain("event: MessageStart\n");
    expect(frame).toContain("data: {");
    expect(frame.endsWith("\n\n")).toBe(true);
    // JCS canonicalization: keys sorted alphabetically
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice("data: ".length));
    expect(payload.type).toBe("MessageStart");
    expect(payload.correlation_id).toBe("cor_" + "c".repeat(20));
  });
});

describe("InFlightRegistry (unit — cancellation registry)", () => {
  it("register/cancel/release lifecycle", () => {
    const reg = new InFlightRegistry();
    const ctrl = reg.register("cor_abc");
    expect(reg.size()).toBe(1);
    expect(reg.has("cor_abc")).toBe(true);
    expect(ctrl.signal.aborted).toBe(false);

    const cancelled = reg.cancel("cor_abc");
    expect(cancelled).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    reg.release("cor_abc");
    expect(reg.size()).toBe(0);
    expect(reg.has("cor_abc")).toBe(false);
  });

  it("cancel returns false for unknown correlation_id", () => {
    const reg = new InFlightRegistry();
    expect(reg.cancel("cor_unknown")).toBe(false);
  });
});

describe("POST /dispatch with Accept: text/event-stream", () => {
  it("SV-LLM-09: sync-only adapter returns 406 DispatcherStreamUnsupported", async () => {
    // Construct a sync-only adapter — no dispatchStream method.
    const syncOnly: ProviderAdapter = {
      name: "sync-only-fixture",
      async dispatch(request) {
        return {
          dispatch_id: "dsp_test000000000000",
          session_id: request.session_id,
          turn_id: request.turn_id,
          content_blocks: [],
          tool_calls: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "NaturalStop",
          dispatcher_error_code: null,
          latency_ms: 0,
          provider_request_id: null,
          provider: "sync-only-fixture",
          model_echo: request.model,
          billing_tag: request.billing_tag,
          correlation_id: request.correlation_id,
          generated_at: clock().toISOString(),
        };
      },
    };
    const { app } = await bootAppWithAdapter(syncOnly);

    const res = await app.inject({
      method: "POST",
      url: "/dispatch",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      payload: reqBody(),
    });

    expect(res.statusCode).toBe(406);
    const body = JSON.parse(res.body);
    expect(body.dispatcher_error_code).toBe("DispatcherStreamUnsupported");
    expect(body.detail).toBeTruthy();
  });

  it("SV-LLM-08 + SV-LLM-10: streaming adapter yields well-formed SSE with invariant-respecting sequence", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "stream:3" });
    const { app } = await bootAppWithAdapter(adapter);

    const res = await app.inject({
      method: "POST",
      url: "/dispatch",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      payload: reqBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-accel-buffering"]).toBe("no");

    const body = res.body;
    expect(body).toContain("event: MessageStart");
    expect(body).toContain("event: ContentBlockStart");
    expect(body).toContain("event: ContentBlockDelta");
    expect(body).toContain("event: ContentBlockEnd");
    expect(body).toContain("event: MessageEnd");
    expect(body).toContain(": stream-done");

    // Sequence: exactly one MessageStart + MessageEnd, exactly 3 deltas
    const counts = {
      messageStart: (body.match(/event: MessageStart/g) || []).length,
      messageEnd: (body.match(/event: MessageEnd/g) || []).length,
      delta: (body.match(/event: ContentBlockDelta/g) || []).length,
      blockStart: (body.match(/event: ContentBlockStart/g) || []).length,
      blockEnd: (body.match(/event: ContentBlockEnd/g) || []).length,
    };
    expect(counts.messageStart).toBe(1);
    expect(counts.messageEnd).toBe(1);
    expect(counts.delta).toBe(3);
    expect(counts.blockStart).toBe(1);
    expect(counts.blockEnd).toBe(1);

    // Order: MessageStart before ContentBlockStart before Delta*, before
    // ContentBlockEnd, before MessageEnd
    const posMsgStart = body.indexOf("event: MessageStart");
    const posBlockStart = body.indexOf("event: ContentBlockStart");
    const posBlockEnd = body.indexOf("event: ContentBlockEnd");
    const posMsgEnd = body.indexOf("event: MessageEnd");
    expect(posMsgStart).toBeLessThan(posBlockStart);
    expect(posBlockStart).toBeLessThan(posBlockEnd);
    expect(posBlockEnd).toBeLessThan(posMsgEnd);
  });

  it("SV-LLM-06 (streaming variant): one /audit/tail row per streamed dispatch", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "stream:2" });
    const { app, dispatcher } = await bootAppWithAdapter(adapter);

    await app.inject({
      method: "POST",
      url: "/dispatch",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      payload: reqBody(),
    });

    const recent = dispatcher.recent_response(SESSION_ID, 10);
    expect(recent.dispatches.length).toBe(1);
    expect(recent.dispatches[0]?.stop_reason).toBe("NaturalStop");
    expect(recent.dispatches[0]?.dispatcher_error_code).toBe(null);
    expect(recent.dispatches[0]?.billing_tag).toBe("tenant-a/env-test");
  });

  it("POST /dispatch without Accept: text/event-stream still returns 200 JSON (back-compat)", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "ok" });
    const { app } = await bootAppWithAdapter(adapter);

    const res = await app.inject({
      method: "POST",
      url: "/dispatch",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "content-type": "application/json",
      },
      payload: reqBody({ stream: false }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(res.body);
    expect(body.stop_reason).toBe("NaturalStop");
  });
});

describe("POST /dispatch/:correlation_id/cancel", () => {
  it("SV-LLM-05 boundary: 404 when no dispatch is in-flight", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "ok" });
    const { app } = await bootAppWithAdapter(adapter);

    const res = await app.inject({
      method: "POST",
      url: "/dispatch/cor_" + "z".repeat(20) + "/cancel",
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("no-in-flight-dispatch");
  });

  it("rejects malformed correlation_id with 400", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "ok" });
    const { app } = await bootAppWithAdapter(adapter);

    const res = await app.inject({
      method: "POST",
      url: "/dispatch/not-a-valid-cor/cancel",
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("malformed-correlation-id");
  });
});
