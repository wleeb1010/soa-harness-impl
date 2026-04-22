import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { SessionPersister } from "../src/session/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";

// Finding Q (SV-BUD-05) + Finding R (SV-BUD-07):
//   - Q: card.tokenBudget.billingTag flows into SessionRecord +
//        PersistedSession on every fresh POST /sessions.
//   - R: request-supplied billing_tag must match the card's (when both
//        are present); divergence raises §24 BillingTagMismatch (403).

const FROZEN_NOW = new Date("2026-04-22T13:00:00.000Z");
const BOOTSTRAP_BEARER = "qr-bootstrap-bearer";
const CARD_BILLING_TAG = "conformance-test";

async function buildApp(dir: string, cardBillingTag?: string) {
  const app = fastify();
  const sessionStore = new InMemorySessionStore();
  const persister = new SessionPersister({ sessionDir: dir });
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  await app.register(sessionsBootstrapPlugin, {
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    cardActiveMode: "DangerFullAccess",
    bootstrapBearer: BOOTSTRAP_BEARER,
    runnerVersion: "1.0",
    persister,
    toolPoolHash: "sha256:qrfixture00000000000000000000000000000000000000000000000000000001",
    cardVersion: "1.0.0",
    emitter,
    agentName: "qr-agent",
    ...(cardBillingTag !== undefined ? { cardBillingTag } : {})
  });
  return { app, sessionStore, persister };
}

describe("Finding Q — card.tokenBudget.billingTag propagation to session", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soa-qr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("card declares billingTag → SessionRecord + PersistedSession both carry it", async () => {
    const ctx = await buildApp(dir, CARD_BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: { requested_activeMode: "ReadOnly", user_sub: "q-subject-1" }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { session_id: string };

      const record = ctx.sessionStore.getRecord(body.session_id);
      expect(record?.billing_tag).toBe(CARD_BILLING_TAG);

      // On-disk file also carries billing_tag.
      const persisted = JSON.parse(
        readFileSync(join(dir, `${body.session_id}.json`), "utf8")
      ) as { billing_tag?: string };
      expect(persisted.billing_tag).toBe(CARD_BILLING_TAG);
    } finally {
      await ctx.app.close();
    }
  });

  it("card omits billingTag → session record has no billing_tag (undefined)", async () => {
    const ctx = await buildApp(dir, undefined);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: { requested_activeMode: "ReadOnly", user_sub: "q-subject-2" }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { session_id: string };
      const record = ctx.sessionStore.getRecord(body.session_id);
      expect(record?.billing_tag).toBeUndefined();
    } finally {
      await ctx.app.close();
    }
  });
});

describe("Finding R — BillingTagMismatch gate on POST /sessions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soa-qr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("request billing_tag matches card → 201 (no gate fired)", async () => {
    const ctx = await buildApp(dir, CARD_BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "r-match",
          billing_tag: CARD_BILLING_TAG
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });

  it("request billing_tag diverges from card → 403 BillingTagMismatch", async () => {
    const ctx = await buildApp(dir, CARD_BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "r-diverge",
          billing_tag: "wrong-tag"
        }
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; detail: string };
      expect(body.error).toBe("BillingTagMismatch");
      expect(body.detail).toContain("wrong-tag");
      expect(body.detail).toContain(CARD_BILLING_TAG);
    } finally {
      await ctx.app.close();
    }
  });

  it("request omits billing_tag → accepted implicitly; session carries the card's value", async () => {
    const ctx = await buildApp(dir, CARD_BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: { requested_activeMode: "ReadOnly", user_sub: "r-implicit" }
      });
      expect(res.statusCode).toBe(201);
      const sid = (JSON.parse(res.body) as { session_id: string }).session_id;
      expect(ctx.sessionStore.getRecord(sid)?.billing_tag).toBe(CARD_BILLING_TAG);
    } finally {
      await ctx.app.close();
    }
  });

  it("card omits billingTag → gate is inert; any request-supplied billing_tag is accepted", async () => {
    const ctx = await buildApp(dir, undefined);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "r-noop",
          billing_tag: "whatever"
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });

  it("malformed billing_tag (non-string) → 400 malformed-request", async () => {
    const ctx = await buildApp(dir, CARD_BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "r-malformed",
          billing_tag: 12345
        }
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("malformed-request");
    } finally {
      await ctx.app.close();
    }
  });
});
