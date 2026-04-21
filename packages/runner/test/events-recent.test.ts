import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { eventsRecentPlugin, StreamEventEmitter } from "../src/stream/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T23:30:00.000Z");
const SESSION = "ses_eventsfixture0000001";
const BEARER = "events-test-bearer";

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
  seedEvents?: number;
} = {}) {
  const app = fastify();
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite" });
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  for (let i = 0; i < (overrides.seedEvents ?? 0); i++) {
    emitter.emit({
      session_id: SESSION,
      type: "ContentBlockDelta",
      payload: { block_id: `block-${i}`, delta: `chunk-${i}` }
    });
  }
  await app.register(eventsRecentPlugin, {
    emitter,
    sessionStore: store,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, store, emitter };
}

describe("GET /events/recent — §14.5 (SV-STR-OBS-01 primer)", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp({ seedEvents: 3 });
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("happy path: 200 + schema-valid body for a seeded session", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = JSON.parse(res.body) as {
      events: Array<Record<string, unknown>>;
      has_more: boolean;
      runner_version: string;
      generated_at: string;
      next_after?: string;
    };
    const validator = schemaRegistry["events-recent-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);
    expect(body.events).toHaveLength(3);
    expect(body.has_more).toBe(false);
    expect(body.next_after).toMatch(/^evt_[0-9a-f]{12}$/);
    // sequence ordering matches emit order.
    expect(body.events.map((e) => e["sequence"])).toEqual([0, 1, 2]);
  });

  it("byte-identity: two reads byte-equal excluding generated_at", async () => {
    const a = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const aBody = JSON.parse(a.body) as Record<string, unknown>;
    const bBody = JSON.parse(b.body) as Record<string, unknown>;
    delete aBody["generated_at"];
    delete bBody["generated_at"];
    expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
  });

  it("pagination with after=<event_id> + limit=<n> walks sequentially", async () => {
    const page1 = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}&limit=2`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const body1 = JSON.parse(page1.body) as {
      events: Array<{ event_id: string }>;
      has_more: boolean;
      next_after?: string;
    };
    expect(body1.events).toHaveLength(2);
    expect(body1.has_more).toBe(true);
    expect(body1.next_after).toBe(body1.events[1]?.event_id);

    const page2 = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}&after=${body1.next_after}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const body2 = JSON.parse(page2.body) as { events: Array<{ sequence: number }>; has_more: boolean };
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0]?.sequence).toBe(2);
    expect(body2.has_more).toBe(false);
  });

  it("not-a-side-effect: read does NOT emit new events", async () => {
    const before = ctx.emitter.snapshot(SESSION).length;
    await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const after = ctx.emitter.snapshot(SESSION).length;
    expect(after).toBe(before);
  });

  it("auth + readiness matrix: 400 / 401 / 403 / 404 / 429 / 503", async () => {
    // 401 missing bearer
    const noAuth = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`
    });
    expect(noAuth.statusCode).toBe(401);

    // 400 missing session_id query param
    const noSid = await ctx.app.inject({
      method: "GET",
      url: `/events/recent`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(noSid.statusCode).toBe(400);

    // 400 malformed session_id
    const bad = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=bogus`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(bad.statusCode).toBe(400);

    // 404 unknown session
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=ses_nonexistentfixture01`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknown.statusCode).toBe(404);

    // 403 wrong bearer
    const wrong = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}`,
      headers: { authorization: `Bearer different-bearer` }
    });
    expect(wrong.statusCode).toBe(403);

    // 404 unknown after
    const unknownAfter = await ctx.app.inject({
      method: "GET",
      url: `/events/recent?session_id=${SESSION}&after=evt_doesnotexist01`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknownAfter.statusCode).toBe(404);

    // 429 rate-limit
    const small = await newApp({ requestsPerMinute: 1, seedEvents: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: `/events/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: `/events/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(429);
    } finally {
      await small.app.close();
    }

    // 503 pre-boot
    const preBoot = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    try {
      const r = await preBoot.app.inject({
        method: "GET",
        url: `/events/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await preBoot.app.close();
    }
  });
});
