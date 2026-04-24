import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRunnerApp } from "../src/server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import { Dispatcher, InMemoryTestAdapter } from "../src/dispatch/index.js";
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
const advance = (ms: number) => {
  clockMs += ms;
};

async function bootAppWithDispatch(opts: { behavior?: string; adminBearer?: string } = {}) {
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });

  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION_ID, BEARER, {
    activeMode: "DangerFullAccess",
    billing_tag: "tenant-a/env-test",
    created_at: clock(),
  });

  const chain = new AuditChain(clock);
  const adapter = new InMemoryTestAdapter({ behavior: opts.behavior ?? "ok" });
  const dispatcher = new Dispatcher({
    adapter,
    auditChain: chain,
    clock,
    random: () => 0.5,
    sleep: async () => undefined,
    runnerVersion: "1.1-test",
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
      runnerVersion: "1.1-test",
      ...(opts.adminBearer !== undefined ? { bootstrapBearer: opts.adminBearer } : {}),
    },
  });
  return { app, dispatcher, adapter, chain, sessionStore };
}

function validDispatchRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    turn_id: "trn_" + "x".repeat(20),
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    budget_ceiling_tokens: 10_000,
    billing_tag: "tenant-a/env-test",
    correlation_id: "cor_" + "c".repeat(20),
    idempotency_key: "idem-" + "d".repeat(20),
    stream: false,
    ...overrides,
  };
}

beforeEach(() => {
  clockMs = 1_700_000_000_000;
});

describe("POST /dispatch — request → response plumbing", () => {
  it("returns 200 + DispatchResponse on a valid request with session bearer", async () => {
    const { app, adapter } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: validDispatchRequest(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.stop_reason).toBe("NaturalStop");
      expect(body.dispatcher_error_code).toBeNull();
      expect(adapter.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns 401 when no bearer", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { "content-type": "application/json" },
        payload: validDispatchRequest(),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when bearer does not match session", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { authorization: `Bearer wrong-bearer`, "content-type": "application/json" },
        payload: validDispatchRequest(),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 404 when session unknown", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: validDispatchRequest({ session_id: "ses_" + "z".repeat(20) }),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when request body fails schema", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: validDispatchRequest({ model: undefined }),
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("dispatch-request-invalid");
    } finally {
      await app.close();
    }
  });

  it("propagates DispatcherError cleanly at HTTP layer (200 + error envelope)", async () => {
    const { app } = await bootAppWithDispatch({ behavior: "error:ProviderAuthFailed" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: validDispatchRequest(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.stop_reason).toBe("DispatcherError");
      expect(body.dispatcher_error_code).toBe("ProviderAuthFailed");
    } finally {
      await app.close();
    }
  });
});

describe("GET /dispatch/recent — observability", () => {
  it("returns 200 + empty dispatches before any calls", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dispatches).toEqual([]);
      expect(body.runner_version).toBe("1.1-test");
    } finally {
      await app.close();
    }
  });

  it("returns newest-first rows after dispatches land", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      for (let i = 0; i < 3; i++) {
        advance(1000);
        await app.inject({
          method: "POST",
          url: "/dispatch",
          headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
          payload: validDispatchRequest({ turn_id: "trn_" + String(i).padStart(20, "0") }),
        });
      }
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dispatches).toHaveLength(3);
      // newest first — the last POSTed turn_id is at index 0
      expect(body.dispatches[0].turn_id).toBe("trn_" + "2".padStart(20, "0"));
      expect(body.dispatches[2].turn_id).toBe("trn_" + "0".padStart(20, "0"));
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a session bearer", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects requests with bearer that doesn't match session", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
        headers: { authorization: `Bearer not-my-bearer` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("admin bearer bypasses per-session bearer check", async () => {
    const ADMIN = "admin-bearer-" + "a".repeat(20);
    const { app } = await bootAppWithDispatch({ adminBearer: ADMIN });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("honors limit param capped at 500", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}&limit=501`,
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed session_id", async () => {
    const { app } = await bootAppWithDispatch();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=not-a-session`,
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("Dispatch routes absent when opts.dispatch is omitted", () => {
  it("POST /dispatch → 404 (route not registered)", async () => {
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
    const app = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: KID,
      privateKey: keys.privateKey,
      x5c: [cert],
      // NO dispatch option
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/dispatch",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("GET /dispatch/recent → 404 (route not registered)", async () => {
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
    const app = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: KID,
      privateKey: keys.privateKey,
      x5c: [cert],
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/dispatch/recent?session_id=${SESSION_ID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
