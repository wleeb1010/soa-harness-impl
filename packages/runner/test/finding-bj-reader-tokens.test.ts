import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  AuditChain,
  auditTailPlugin,
  auditRecordsPlugin,
  auditReaderTokensPlugin,
  ReaderTokenStore,
  makeReaderScopeGuard,
  READER_BEARER_PREFIX,
  looksLikeReaderBearer,
  readerAllowedPath
} from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";

// Finding BJ / §10.5.7 — /audit/reader-tokens mints short-TTL reader
// bearers; reader bearers succeed only on GET /audit/tail + /audit/records.

const FROZEN_NOW = new Date("2026-04-22T12:00:00.000Z");
const OPERATOR_BEARER = "bj-operator-bearer";
const SESSION_ID = "ses_bjFixture00000000001";
const SESSION_BEARER = "bj-session-bearer";

async function newApp() {
  const store = new ReaderTokenStore(() => FROZEN_NOW);
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION_ID, SESSION_BEARER, {
    activeMode: "WorkspaceWrite",
    canDecide: true
  });
  const chain = new AuditChain(() => FROZEN_NOW);
  const app = fastify();
  app.addHook("onRequest", makeReaderScopeGuard(store));
  await app.register(auditTailPlugin, {
    chain,
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    readerTokens: store
  });
  await app.register(auditRecordsPlugin, {
    chain,
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    readerTokens: store
  });
  await app.register(auditReaderTokensPlugin, {
    store,
    clock: () => FROZEN_NOW,
    readiness: { check: () => null },
    runnerVersion: "1.0",
    operatorBearer: OPERATOR_BEARER
  });
  return { app, store, chain, sessionStore };
}

describe("Finding BJ — helpers", () => {
  it("looksLikeReaderBearer matches auditrdr_ prefix only", () => {
    expect(looksLikeReaderBearer(`${READER_BEARER_PREFIX}abcdef`)).toBe(true);
    expect(looksLikeReaderBearer("sessionbearer")).toBe(false);
  });
  it("readerAllowedPath allows only GET /audit/{tail,records}", () => {
    expect(readerAllowedPath("GET", "/audit/tail")).toBe(true);
    expect(readerAllowedPath("GET", "/audit/records")).toBe(true);
    expect(readerAllowedPath("GET", "/audit/records?after=aud_x")).toBe(true);
    expect(readerAllowedPath("POST", "/audit/tail")).toBe(false);
    expect(readerAllowedPath("GET", "/permissions/decisions")).toBe(false);
    expect(readerAllowedPath("PUT", "/audit/records/aud_x")).toBe(false);
  });
});

describe("Finding BJ — POST /audit/reader-tokens minting", () => {
  it("operator bearer + no body → 201 with default 900s TTL", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        reader_bearer: string;
        expires_at: string;
        scope: string;
      };
      expect(body.reader_bearer.startsWith(READER_BEARER_PREFIX)).toBe(true);
      expect(body.scope).toBe("audit:read:*");
      // 900s from FROZEN_NOW
      const delta = new Date(body.expires_at).getTime() - FROZEN_NOW.getTime();
      expect(delta).toBe(900 * 1000);
    } finally {
      await ctx.app.close();
    }
  });

  it("operator bearer + explicit ttl_seconds=120 → 201 with 120s TTL", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: { ttl_seconds: 120 }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { expires_at: string };
      const delta = new Date(body.expires_at).getTime() - FROZEN_NOW.getTime();
      expect(delta).toBe(120 * 1000);
    } finally {
      await ctx.app.close();
    }
  });

  it("ttl_seconds < 60 → 400 ttl-seconds-out-of-range", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: { ttl_seconds: 30 }
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("ttl-seconds-out-of-range");
    } finally {
      await ctx.app.close();
    }
  });

  it("ttl_seconds > 3600 → 400 ttl-seconds-out-of-range", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: { ttl_seconds: 7200 }
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("ttl-seconds-out-of-range");
    } finally {
      await ctx.app.close();
    }
  });

  it("non-operator bearer → 403 bearer-lacks-operator-scope", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${SESSION_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("bearer-lacks-operator-scope");
    } finally {
      await ctx.app.close();
    }
  });

  it("no bearer → 401", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await ctx.app.close();
    }
  });
});

describe("Finding BJ — reader bearer scope enforcement", () => {
  it("reader bearer reads GET /audit/tail → 200", async () => {
    const ctx = await newApp();
    try {
      const mint = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      const { reader_bearer } = JSON.parse(mint.body);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/audit/tail",
        headers: { authorization: `Bearer ${reader_bearer}` }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it("reader bearer reads GET /audit/records → 200", async () => {
    const ctx = await newApp();
    try {
      const mint = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      const { reader_bearer } = JSON.parse(mint.body);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/audit/records",
        headers: { authorization: `Bearer ${reader_bearer}` }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it("reader bearer on POST /audit/reader-tokens → 403 bearer-lacks-audit-write-scope (non-allowed path)", async () => {
    const ctx = await newApp();
    try {
      const mint = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      const { reader_bearer } = JSON.parse(mint.body);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${reader_bearer}`, "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("bearer-lacks-audit-write-scope");
    } finally {
      await ctx.app.close();
    }
  });

  it("reader bearer on PUT /audit/records/:id → 403 bearer-lacks-audit-write-scope (path guard trumps route)", async () => {
    const ctx = await newApp();
    try {
      const mint = await ctx.app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      const { reader_bearer } = JSON.parse(mint.body);
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/audit/records/aud_anything",
        headers: { authorization: `Bearer ${reader_bearer}`, "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("bearer-lacks-audit-write-scope");
    } finally {
      await ctx.app.close();
    }
  });

  it("expired reader bearer → 401 reader-bearer-expired", async () => {
    let clockNow = FROZEN_NOW;
    const store = new ReaderTokenStore(() => clockNow);
    const sessionStore = new InMemorySessionStore();
    sessionStore.register(SESSION_ID, SESSION_BEARER, { activeMode: "WorkspaceWrite" });
    const chain = new AuditChain(() => FROZEN_NOW);
    const app = fastify();
    app.addHook("onRequest", makeReaderScopeGuard(store));
    await app.register(auditTailPlugin, {
      chain,
      sessionStore,
      readiness: { check: () => null },
      clock: () => clockNow,
      readerTokens: store
    });
    await app.register(auditReaderTokensPlugin, {
      store,
      clock: () => clockNow,
      readiness: { check: () => null },
      operatorBearer: OPERATOR_BEARER
    });
    try {
      const mint = await app.inject({
        method: "POST",
        url: "/audit/reader-tokens",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: { ttl_seconds: 60 }
      });
      const { reader_bearer } = JSON.parse(mint.body);
      // Advance past expiry.
      clockNow = new Date(FROZEN_NOW.getTime() + 61_000);
      const res = await app.inject({
        method: "GET",
        url: "/audit/tail",
        headers: { authorization: `Bearer ${reader_bearer}` }
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe("reader-bearer-expired");
    } finally {
      await app.close();
    }
  });
});
