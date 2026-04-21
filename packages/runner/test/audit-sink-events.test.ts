import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import {
  AuditSink,
  auditSinkEventsPlugin,
  type AuditSinkEvent
} from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessProbe, ReadinessReason } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T15:00:00.000Z");
const SESSION = "ses_sinkevtfixture00001";
const BEARER = "sink-events-bearer";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-sink-events-"));
}

function buildReadiness(reason: ReadinessReason | null): ReadinessProbe {
  return { check: () => reason };
}

async function newApp(overrides: {
  sink?: AuditSink;
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
} = {}) {
  const dir = tmpDir();
  const sink =
    overrides.sink ??
    new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite" });
  const app = fastify();
  await app.register(auditSinkEventsPlugin, {
    sink,
    sessionStore: store,
    readiness: overrides.readiness ?? buildReadiness(null),
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, sink, store, dir };
}

describe("GET /audit/sink-events — §12.5.4", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(async () => {
    await ctx.app.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("happy path: 200 + schema-valid body with one AuditSinkDegraded event after a state transition", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = JSON.parse(res.body) as {
      events: AuditSinkEvent[];
      has_more: boolean;
      runner_version: string;
      generated_at: string;
      next_after?: string;
    };
    const validator = schemaRegistry["audit-sink-events-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);

    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.type).toBe("AuditSinkDegraded");
    expect(body.has_more).toBe(false);
    expect(body.runner_version).toBe("1.0");
    expect(body.generated_at).toBe(FROZEN_NOW.toISOString());
    expect(body.next_after).toBe(body.events[0]?.event_id);
  });

  it("byte-identity: two successive reads are byte-equal when generated_at is excluded", async () => {
    const a = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const aBody = JSON.parse(a.body) as Record<string, unknown>;
    const bBody = JSON.parse(b.body) as Record<string, unknown>;
    delete aBody["generated_at"];
    delete bBody["generated_at"];
    expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
  });

  it("multi-event pagination: after=<event_id>&limit=<n> walks in order", async () => {
    // Drive three transitions: degraded → halt → healthy (recovered).
    ctx.sink.transitionTo("unreachable-halt", "test-drive");
    await ctx.sink.flushAndRecover(async () => undefined);

    const page1 = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events?limit=1",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(page1.statusCode).toBe(200);
    const body1 = JSON.parse(page1.body) as {
      events: AuditSinkEvent[];
      has_more: boolean;
      next_after?: string;
    };
    expect(body1.events).toHaveLength(1);
    expect(body1.events[0]?.type).toBe("AuditSinkDegraded");
    expect(body1.has_more).toBe(true);

    const page2 = await ctx.app.inject({
      method: "GET",
      url: `/audit/sink-events?after=${body1.next_after}&limit=1`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const body2 = JSON.parse(page2.body) as {
      events: AuditSinkEvent[];
      has_more: boolean;
      next_after?: string;
    };
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0]?.type).toBe("AuditSinkUnreachable");
    expect(body2.has_more).toBe(true);

    const page3 = await ctx.app.inject({
      method: "GET",
      url: `/audit/sink-events?after=${body2.next_after}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const body3 = JSON.parse(page3.body) as { events: AuditSinkEvent[]; has_more: boolean };
    expect(body3.events).toHaveLength(1);
    expect(body3.events[0]?.type).toBe("AuditSinkRecovered");
    expect(body3.has_more).toBe(false);
  });

  it("auth + readiness + rate-limit matrix: 401/403/404/429/503", async () => {
    // 401 — no bearer
    const noAuth = await ctx.app.inject({ method: "GET", url: "/audit/sink-events" });
    expect(noAuth.statusCode).toBe(401);

    // 403 — unknown bearer (doesn't map to any session)
    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events",
      headers: { authorization: `Bearer nope-not-registered` }
    });
    expect(wrong.statusCode).toBe(403);

    // 404 — after=<unknown event_id>
    const unknown = await ctx.app.inject({
      method: "GET",
      url: "/audit/sink-events?after=evt_nonexistent0001",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknown.statusCode).toBe(404);

    // 429 — small limit exhausts quickly
    const small = await newApp({ requestsPerMinute: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: "/audit/sink-events",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: "/audit/sink-events",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(429);
      expect(b.headers["retry-after"]).toBeDefined();
    } finally {
      await small.app.close();
      rmSync(small.dir, { recursive: true, force: true });
    }

    // 503 — pre-boot readiness reason
    const preBoot = await newApp({ readiness: buildReadiness("bootstrap-pending") });
    try {
      const r = await preBoot.app.inject({
        method: "GET",
        url: "/audit/sink-events",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
      const body = JSON.parse(r.body) as { status: string; reason: string };
      expect(body.status).toBe("not-ready");
      expect(body.reason).toBe("bootstrap-pending");
    } finally {
      await preBoot.app.close();
      rmSync(preBoot.dir, { recursive: true, force: true });
    }
  });
});
