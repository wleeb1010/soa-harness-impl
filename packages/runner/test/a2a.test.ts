/**
 * §17 A2A plugin — unit tests for W1 plumbing.
 *
 * Covers: JSON-RPC envelope validation, auth, 5 method handlers,
 * monotonicity per §17.2.1, digest shape per §17.2, deadlines per §17.2.2.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  a2aPlugin,
  A2aTaskRegistry,
  A2A_ERROR_CODES,
  A2A_TERMINAL_HANDOFF_STATUS,
  A2A_DEFAULT_DEADLINES,
  isWellFormedA2aDigest,
  resolveA2aDeadlines,
} from "../src/a2a/index.js";

const VALID_DIGEST = "sha256:" + "a".repeat(64);
const BEARER = "test-a2a-bearer-" + "x".repeat(20);

async function bootApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  await app.register(a2aPlugin, {
    bearer: BEARER,
    card: { name: "test-agent", version: "1.0", capabilities: [] },
    cardJws: "header.PLACEHOLDER.sig",
  });
  return app;
}

describe("A2aTaskRegistry (§17.2.1 monotonicity)", () => {
  it("records terminal status and refuses backward transitions", () => {
    const reg = new A2aTaskRegistry();
    reg.record("task_a", "accepted", "evt_1");
    reg.record("task_a", "executing", "evt_2");
    reg.record("task_a", "completed", "evt_3");
    expect(reg.get("task_a")?.status).toBe("completed");
    // Terminal lock-in
    reg.record("task_a", "executing", "evt_4");
    expect(reg.get("task_a")?.status).toBe("completed");
  });

  it("terminal set has exactly 4 values from §17.2.1", () => {
    expect(A2A_TERMINAL_HANDOFF_STATUS.size).toBe(4);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("completed")).toBe(true);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("rejected")).toBe(true);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("failed")).toBe(true);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("timed-out")).toBe(true);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("accepted")).toBe(false);
    expect(A2A_TERMINAL_HANDOFF_STATUS.has("executing")).toBe(false);
  });
});

describe("isWellFormedA2aDigest (§17.2 digest shape)", () => {
  it("accepts sha256:<64-hex-lowercase>", () => {
    expect(isWellFormedA2aDigest(VALID_DIGEST)).toBe(true);
  });
  it("rejects uppercase hex", () => {
    expect(isWellFormedA2aDigest("sha256:" + "A".repeat(64))).toBe(false);
  });
  it("rejects wrong algorithm", () => {
    expect(isWellFormedA2aDigest("sha1:" + "a".repeat(40))).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(isWellFormedA2aDigest("sha256:" + "a".repeat(63))).toBe(false);
  });
  it("rejects missing prefix", () => {
    expect(isWellFormedA2aDigest("a".repeat(64))).toBe(false);
  });
});

describe("resolveA2aDeadlines (§17.2.2)", () => {
  it("returns defaults when env is empty", () => {
    const d = resolveA2aDeadlines({});
    expect(d).toEqual(A2A_DEFAULT_DEADLINES);
  });
  it("overrides with positive integers from env", () => {
    const d = resolveA2aDeadlines({
      SOA_A2A_TASK_DEADLINE_S: "600",
      SOA_A2A_STATUS_DEADLINE_S: "10",
    });
    expect(d.task_execution_s).toBe(600);
    expect(d.status_s).toBe(10);
    expect(d.describe_s).toBe(A2A_DEFAULT_DEADLINES.describe_s);
  });
  it("ignores malformed values", () => {
    const d = resolveA2aDeadlines({
      SOA_A2A_TASK_DEADLINE_S: "-1",
      SOA_A2A_STATUS_DEADLINE_S: "abc",
    });
    expect(d.task_execution_s).toBe(A2A_DEFAULT_DEADLINES.task_execution_s);
    expect(d.status_s).toBe(A2A_DEFAULT_DEADLINES.status_s);
  });
});

describe("POST /a2a/v1 — envelope + auth", () => {
  it("rejects non-JSON-RPC body with -32600", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { foo: "bar" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });

  it("returns AuthFailed on missing bearer", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(A2A_ERROR_CODES.AuthFailed);
  });

  it("returns AuthFailed on wrong bearer", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: "Bearer wrong-bearer", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    expect(JSON.parse(res.body).error.code).toBe(A2A_ERROR_CODES.AuthFailed);
  });

  it("returns -32601 on unknown method", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "handoff.unknown" },
    });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32601);
  });

  it("surfaces deadlines via x-a2a-task-deadline-s header", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    expect(res.headers["x-a2a-task-deadline-s"]).toBe("300");
  });
});

describe("POST /a2a/v1 — agent.describe", () => {
  it("echoes card + placeholder JWS", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const body = JSON.parse(res.body);
    expect(body.result.card.name).toBe("test-agent");
    expect(body.result.jws).toContain("PLACEHOLDER");
  });
});

describe("POST /a2a/v1 — handoff.offer", () => {
  it("accepts well-formed offer", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "1",
        method: "handoff.offer",
        params: {
          task_id: "task_abc",
          summary: "summarize last 5 turns",
          messages_digest: VALID_DIGEST,
          workflow_digest: VALID_DIGEST,
          capabilities_needed: ["summarize"],
        },
      },
    });
    const body = JSON.parse(res.body);
    expect(body.result.accept).toBe(true);
  });

  it("rejects malformed digest with HandoffRejected + digest-mismatch", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "1",
        method: "handoff.offer",
        params: {
          task_id: "task_abc",
          summary: "x",
          messages_digest: "not-a-digest",
          workflow_digest: VALID_DIGEST,
          capabilities_needed: [],
        },
      },
    });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(A2A_ERROR_CODES.HandoffRejected);
    expect(body.error.data.reason).toBe("digest-mismatch");
  });
});

describe("POST /a2a/v1 — handoff.transfer + handoff.status flow", () => {
  it("transfer records accepted; status returns it; return records completed", async () => {
    const app = await bootApp();
    const transfer = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "1",
        method: "handoff.transfer",
        params: {
          task_id: "task_flow",
          messages: [{ role: "user", content: "hi" }],
          workflow: { task_id: "task_flow", status: "Handoff", side_effects: [] },
          billing_tag: "tenant-a/env-test",
          correlation_id: "cor_" + "c".repeat(20),
        },
      },
    });
    expect(JSON.parse(transfer.body).result.destination_session_id).toMatch(/^ses_/);

    const status1 = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "2", method: "handoff.status", params: { task_id: "task_flow" } },
    });
    expect(JSON.parse(status1.body).result.status).toBe("accepted");

    const ret = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "3",
        method: "handoff.return",
        params: { task_id: "task_flow", result_digest: VALID_DIGEST, final_messages: [] },
      },
    });
    expect(JSON.parse(ret.body).result.ack).toBe(true);

    const status2 = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "4", method: "handoff.status", params: { task_id: "task_flow" } },
    });
    expect(JSON.parse(status2.body).result.status).toBe("completed");
  });

  it("status on unknown task_id returns HandoffStateIncompatible", async () => {
    const app = await bootApp();
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "handoff.status", params: { task_id: "nonexistent" } },
    });
    expect(JSON.parse(res.body).error.code).toBe(A2A_ERROR_CODES.HandoffStateIncompatible);
  });
});
