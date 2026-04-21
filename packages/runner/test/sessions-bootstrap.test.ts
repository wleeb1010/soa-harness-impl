import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN = new Date("2026-04-20T12:00:00.000Z");
const BOOTSTRAP_BEARER = "op-tool-bootstrap-bearer-xyz";

async function newApp(
  overrides: {
    cardActiveMode?: "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
    readiness?: ReadinessProbe;
    sessionStore?: InMemorySessionStore;
    requestsPerMinute?: number;
    bootstrapBearer?: string;
  } = {}
) {
  const app = fastify();
  const store = overrides.sessionStore ?? new InMemorySessionStore();
  await app.register(sessionsBootstrapPlugin, {
    sessionStore: store,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN,
    cardActiveMode: overrides.cardActiveMode ?? "WorkspaceWrite",
    bootstrapBearer: overrides.bootstrapBearer ?? BOOTSTRAP_BEARER,
    defaultTtlSeconds: 3600,
    maxTtlSeconds: 86_400,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined ? { requestsPerMinute: overrides.requestsPerMinute } : {})
  });
  return { app, store };
}

describe("POST /sessions — happy path (§12.6)", () => {
  it("returns 201 + schema-valid body for each permitted activeMode", async () => {
    const modes: Array<"ReadOnly" | "WorkspaceWrite" | "DangerFullAccess"> = [
      "ReadOnly",
      "WorkspaceWrite",
      "DangerFullAccess"
    ];
    const validate = schemaRegistry["session-bootstrap-response"];
    for (const mode of modes) {
      const { app } = await newApp({ cardActiveMode: "DangerFullAccess" });
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify({ requested_activeMode: mode, user_sub: "alice" })
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(validate(body)).toBe(true);
      expect(body.granted_activeMode).toBe(mode);
      expect(body.session_id).toMatch(/^ses_[A-Za-z0-9]{16,}$/);
      expect(body.session_bearer.length).toBeGreaterThanOrEqual(32);
      expect(body.runner_version).toBe("1.0");
      await app.close();
    }
  });

  it("expires_at = created_at + requested ttl (or default)", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice", session_ttl_seconds: 120 })
    });
    const body = JSON.parse(res.body);
    expect(new Date(body.expires_at).getTime()).toBe(FROZEN.getTime() + 120_000);
    await app.close();
  });
});

describe("POST /sessions — error paths", () => {
  it("returns 401 when no bearer is presented", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 when a wrong bootstrap bearer is presented", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 for malformed JSON / missing required fields", async () => {
    const { app } = await newApp();
    const bad = [
      {},
      { requested_activeMode: "NotAMode", user_sub: "alice" },
      { requested_activeMode: "ReadOnly" }, // missing user_sub
      { requested_activeMode: "ReadOnly", user_sub: "alice", session_ttl_seconds: 5 } // ttl < min
    ];
    for (const body of bad) {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify(body)
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("returns 403 ConfigPrecedenceViolation when requested_activeMode > cardActiveMode", async () => {
    const { app } = await newApp({ cardActiveMode: "WorkspaceWrite" });
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "DangerFullAccess", user_sub: "alice" })
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ConfigPrecedenceViolation");
    await app.close();
  });

  it("returns 429 + Retry-After once the rate limit is exceeded", async () => {
    const { app } = await newApp({ requestsPerMinute: 2 });
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
      });
      expect(ok.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("returns 503 with §5.4 shape when readiness is pending", async () => {
    const { app } = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).reason).toBe("bootstrap-pending");
    await app.close();
  });
});

describe("POST /sessions — T-03 request_decide_scope extension", () => {
  async function bootstrapAndGetRecord(
    body: Record<string, unknown>
  ): Promise<{ statusCode: number; store: InMemorySessionStore; session_id?: string }> {
    const { app, store } = await newApp({ cardActiveMode: "DangerFullAccess" });
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify(body)
    });
    const parsed = res.statusCode === 201 ? JSON.parse(res.body) : null;
    await app.close();
    return {
      statusCode: res.statusCode,
      store,
      ...(parsed ? { session_id: parsed.session_id as string } : {})
    };
  }

  it("omitted request_decide_scope → session.canDecide === false (decide endpoint would 403)", async () => {
    const { statusCode, store, session_id } = await bootstrapAndGetRecord({
      requested_activeMode: "ReadOnly",
      user_sub: "alice"
    });
    expect(statusCode).toBe(201);
    const rec = store.getRecord(session_id!);
    expect(rec?.canDecide).toBe(false);
  });

  it("request_decide_scope:true → session.canDecide === true", async () => {
    const { statusCode, store, session_id } = await bootstrapAndGetRecord({
      requested_activeMode: "DangerFullAccess",
      user_sub: "alice",
      request_decide_scope: true
    });
    expect(statusCode).toBe(201);
    const rec = store.getRecord(session_id!);
    expect(rec?.canDecide).toBe(true);
  });

  it("request_decide_scope:false explicit → same as omitted (canDecide === false)", async () => {
    const { statusCode, store, session_id } = await bootstrapAndGetRecord({
      requested_activeMode: "ReadOnly",
      user_sub: "alice",
      request_decide_scope: false
    });
    expect(statusCode).toBe(201);
    const rec = store.getRecord(session_id!);
    expect(rec?.canDecide).toBe(false);
  });

  it("non-boolean request_decide_scope → 400 malformed-request", async () => {
    const { app } = await newApp({ cardActiveMode: "DangerFullAccess" });
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        requested_activeMode: "ReadOnly",
        user_sub: "alice",
        request_decide_scope: "yes" // not a boolean
      })
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("scope bookkeeping round-trips: session_bearer validates, getRecord reflects canDecide", async () => {
    const { app, store } = await newApp({ cardActiveMode: "DangerFullAccess" });
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        requested_activeMode: "WorkspaceWrite",
        user_sub: "bob",
        request_decide_scope: true
      })
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const sid = body.session_id as string;
    const bearer = body.session_bearer as string;
    expect(store.validate(sid, bearer)).toBe(true);
    expect(store.getRecord(sid)?.canDecide).toBe(true);
    expect(store.getRecord(sid)?.activeMode).toBe("WorkspaceWrite");
    await app.close();
  });
});
