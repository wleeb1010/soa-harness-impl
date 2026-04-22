import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { InMemorySessionStore } from "../src/permission/index.js";
import {
  OtelSpanStore,
  BackpressureState,
  BACKPRESSURE_BUFFER_CAPACITY,
  otelSpansRecentPlugin,
  backpressureStatusPlugin,
  type OtelSpanRecord
} from "../src/observability/index.js";
import { registry as schemas } from "@soa-harness/schemas";

// L-36 §14.5.2 /observability/otel-spans/recent + §14.5.3
// /observability/backpressure coverage. Tests cover the M3 cold-state
// (empty ring + zero counters), auth gating, and schema conformance of
// the response body.

const FROZEN_NOW = new Date("2026-04-22T06:00:00.000Z");
const SESSION = "ses_obsotelfixture00000001";
const BEARER = "obs-otel-bearer";
const BOOTSTRAP_BEARER = "obs-bootstrap-bearer";

function sampleSpan(overrides: Partial<OtelSpanRecord> = {}): OtelSpanRecord {
  return {
    span_id: "0123456789abcdef",
    trace_id: "0123456789abcdef0123456789abcdef",
    parent_span_id: null,
    name: "decisions.handler",
    start_time: FROZEN_NOW.toISOString(),
    end_time: FROZEN_NOW.toISOString(),
    attributes: { "soa.session_id": SESSION },
    status_code: "OK",
    resource_attributes: { "service.name": "soa-runner" },
    ...overrides
  };
}

describe("§14.5.2 /observability/otel-spans/recent", () => {
  async function build(store: OtelSpanStore) {
    const sessionStore = new InMemorySessionStore();
    sessionStore.register(SESSION, BEARER, { activeMode: "ReadOnly", canDecide: false });
    const app = fastify();
    await app.register(otelSpansRecentPlugin, {
      store,
      sessionStore,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      runnerVersion: "1.0"
    });
    return { app, sessionStore };
  }

  it("cold-state (empty ring): 200 with spans:[], has_more:false, schema-valid body", async () => {
    const store = new OtelSpanStore();
    const ctx = await build(store);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spans).toEqual([]);
      expect(body.has_more).toBe(false);
      expect(body.runner_version).toBe("1.0");
      expect(body.generated_at).toBe(FROZEN_NOW.toISOString());
      // Schema conformance via the pinned registry.
      expect(schemas["otel-spans-recent-response"](body)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("populated ring: returns spans in append order; next_after = last span_id", async () => {
    const store = new OtelSpanStore();
    store.append(SESSION, sampleSpan({ span_id: "0000000000000001", name: "span.a" }));
    store.append(SESSION, sampleSpan({ span_id: "0000000000000002", name: "span.b" }));
    store.append(SESSION, sampleSpan({ span_id: "0000000000000003", name: "span.c" }));
    const ctx = await build(store);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}&limit=2`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spans).toHaveLength(2);
      expect(body.spans.map((s: OtelSpanRecord) => s.name)).toEqual(["span.a", "span.b"]);
      expect(body.has_more).toBe(true);
      expect(body.next_after).toBe("0000000000000002");
      expect(schemas["otel-spans-recent-response"](body)).toBe(true);

      // Pagination: after=0000000000000002 → page 2 has span.c only.
      const res2 = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}&after=0000000000000002&limit=2`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.spans.map((s: OtelSpanRecord) => s.name)).toEqual(["span.c"]);
      expect(body2.has_more).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });

  it("missing bearer → 401; wrong-session bearer → 403", async () => {
    const store = new OtelSpanStore();
    const ctx = await build(store);
    try {
      const unauth = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`
      });
      expect(unauth.statusCode).toBe(401);

      const other = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer some-other-bearer` }
      });
      expect(other.statusCode).toBe(403);
    } finally {
      await ctx.app.close();
    }
  });

  it("malformed session_id → 400; unknown session → 404; unknown after → 404", async () => {
    const store = new OtelSpanStore();
    const ctx = await build(store);
    try {
      const bad = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=not-a-session`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(bad.statusCode).toBe(400);

      const missingSession = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=ses_neverregisteredsession01`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(missingSession.statusCode).toBe(404);

      const missingAfter = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}&after=ffffffffffffffff`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(missingAfter.statusCode).toBe(404);
    } finally {
      await ctx.app.close();
    }
  });

  it("NOT-A-SIDE-EFFECT: two reads leave the store byte-identical", async () => {
    const store = new OtelSpanStore();
    store.append(SESSION, sampleSpan({ span_id: "0000000000000009" }));
    const ctx = await build(store);
    try {
      const r1 = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const r2 = await ctx.app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b1 = JSON.parse(r1.body);
      const b2 = JSON.parse(r2.body);
      delete b1.generated_at;
      delete b2.generated_at;
      expect(b1).toEqual(b2);
      // Store count unchanged (no reads mutate).
      expect(store.snapshot(SESSION)).toHaveLength(1);
    } finally {
      await ctx.app.close();
    }
  });
});

describe("§14.5.3 /observability/backpressure", () => {
  async function build(state: BackpressureState) {
    const sessionStore = new InMemorySessionStore();
    sessionStore.register(SESSION, BEARER, { activeMode: "ReadOnly", canDecide: false });
    const app = fastify();
    await app.register(backpressureStatusPlugin, {
      state,
      sessionStore,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      bootstrapBearer: BOOTSTRAP_BEARER,
      runnerVersion: "1.0"
    });
    return { app, sessionStore };
  }

  it("cold-state: 200 with capacity=10000, zero counters, null last-applied; schema-valid", async () => {
    const state = new BackpressureState({ clock: () => FROZEN_NOW });
    const ctx = await build(state);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.buffer_capacity).toBe(BACKPRESSURE_BUFFER_CAPACITY);
      expect(body.buffer_size_current).toBe(0);
      expect(body.dropped_since_boot).toBe(0);
      expect(body.last_backpressure_applied_at).toBeNull();
      expect(body.last_backpressure_dropped_count).toBe(0);
      expect(body.runner_version).toBe("1.0");
      expect(body.generated_at).toBe(FROZEN_NOW.toISOString());
      expect(schemas["backpressure-status-response"](body)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("after applied(): dropped_since_boot monotonic advances; last_backpressure_applied_at non-null", async () => {
    const state = new BackpressureState({ clock: () => FROZEN_NOW });
    state.applied(7);
    state.applied(3);
    const ctx = await build(state);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dropped_since_boot).toBe(10); // monotonic 7+3
      expect(body.last_backpressure_dropped_count).toBe(3); // most recent
      expect(body.last_backpressure_applied_at).toBe(FROZEN_NOW.toISOString());
      expect(schemas["backpressure-status-response"](body)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("session bearer (any registered) also satisfies admin:read — /audit/records parity", async () => {
    const state = new BackpressureState({ clock: () => FROZEN_NOW });
    const ctx = await build(state);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it("no bearer → 401; unknown bearer → 403 bearer-lacks-admin-read-scope", async () => {
    const state = new BackpressureState({ clock: () => FROZEN_NOW });
    const ctx = await build(state);
    try {
      const unauth = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure"
      });
      expect(unauth.statusCode).toBe(401);

      const wrong = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer not-a-real-bearer` }
      });
      expect(wrong.statusCode).toBe(403);
      expect(JSON.parse(wrong.body).error).toBe("bearer-lacks-admin-read-scope");
    } finally {
      await ctx.app.close();
    }
  });

  it("NOT-A-SIDE-EFFECT: two reads leave state byte-identical", async () => {
    const state = new BackpressureState({ clock: () => FROZEN_NOW });
    state.applied(5);
    state.setBufferSize(1234);
    const ctx = await build(state);
    try {
      const r1 = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      const r2 = await ctx.app.inject({
        method: "GET",
        url: "/observability/backpressure",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      const b1 = JSON.parse(r1.body);
      const b2 = JSON.parse(r2.body);
      delete b1.generated_at;
      delete b2.generated_at;
      expect(b1).toEqual(b2);
      // Counters stable across reads.
      const snap = state.snapshot();
      expect(snap.dropped_since_boot).toBe(5);
      expect(snap.buffer_size_current).toBe(1234);
    } finally {
      await ctx.app.close();
    }
  });
});
