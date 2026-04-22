import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import {
  OtelEmitter,
  OtelSpanStore,
  DEFAULT_REQUIRED_RESOURCE_ATTRS
} from "../src/observability/index.js";
import { registry as schemas } from "@soa-harness/schemas";

// Finding W / SV-STR-06 + SV-STR-07 — OTel emitter wired to the decision
// call-site. Every committed POST /permissions/decisions fires:
//   soa.turn  (outer envelope)
//   soa.tool.<tool_name>  (child, trace_id matches; parent_span_id = turn span_id)
// Both spans:
//   - carry the §14.4 resource_attributes (defaults when card omits)
//   - carry the PermissionDecision StreamEvent event_id as a span event
//   - appear in the OtelSpanStore the /observability/otel-spans/recent
//     endpoint reads (one ring, no duplicate transport)

const FROZEN_NOW = new Date("2026-04-22T09:00:00.000Z");
const SESSION = "ses_otelemitfixture000001";
const BEARER = "otel-emit-bearer";

async function buildApp(store: OtelSpanStore, emitter?: OtelEmitter) {
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
  ]);
  const streamEmitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore,
    chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    emitter: streamEmitter,
    ...(emitter !== undefined ? { otelEmitter: emitter } : {})
  });
  return { app, sessionStore, chain, streamEmitter, store };
}

describe("Finding W — decision call-site emits soa.turn + soa.tool.* spans", () => {
  it("one decision → turn + tool spans in the OtelSpanStore; trace_id matches; tool.parent_span_id = turn.span_id", async () => {
    const store = new OtelSpanStore();
    const emitter = new OtelEmitter({
      store,
      agentName: "test-agent",
      agentVersion: "1.0.0",
      billingTag: "conformance-test",
      clock: () => FROZEN_NOW
    });
    const ctx = await buildApp(store, emitter);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:aaaa111111111111111111111111111111111111111111111111111111111111"
        }
      });
      expect(res.statusCode).toBe(201);

      const spans = store.snapshot(SESSION);
      expect(spans).toHaveLength(2);
      const turn = spans.find((s) => s.name === "soa.turn")!;
      const tool = spans.find((s) => s.name === "soa.tool.fs__read_file")!;
      expect(turn).toBeDefined();
      expect(tool).toBeDefined();

      // Both spans share a trace_id; tool's parent is the turn span.
      expect(tool.trace_id).toBe(turn.trace_id);
      expect(tool.parent_span_id).toBe(turn.span_id);
      expect(turn.parent_span_id).toBeNull();

      // Required attributes on soa.turn.
      expect(turn.attributes).toMatchObject({
        "soa.session.id": SESSION,
        "soa.agent.name": "test-agent",
        "soa.agent.version": "1.0.0",
        "soa.billing.tag": "conformance-test"
      });
      expect(turn.attributes["soa.turn.id"]).toBeDefined();

      // Required attributes on soa.tool.<name>.
      expect(tool.attributes).toMatchObject({
        "soa.tool.risk_class": "ReadOnly",
        "soa.permission.decision": "AutoAllow"
      });

      // resource_attributes include every §14.4 default name (plus the
      // known values stamped in).
      for (const name of DEFAULT_REQUIRED_RESOURCE_ATTRS) {
        expect(turn.resource_attributes).toHaveProperty(name);
        expect(tool.resource_attributes).toHaveProperty(name);
      }
      expect(turn.resource_attributes["soa.billing.tag"]).toBe("conformance-test");
    } finally {
      await ctx.app.close();
    }
  });

  it("StreamEvent.event_id appears as a span event on both spans", async () => {
    const store = new OtelSpanStore();
    const emitter = new OtelEmitter({
      store,
      agentName: "test-agent",
      agentVersion: "1.0.0",
      billingTag: "conformance-test",
      clock: () => FROZEN_NOW
    });
    const ctx = await buildApp(store, emitter);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbb222222222222222222222222222222222222222222222222222222222222"
        }
      });
      expect(res.statusCode).toBe(201);

      const streamEvents = ctx.streamEmitter.snapshot(SESSION);
      const pd = streamEvents.find((e) => e.type === "PermissionDecision");
      expect(pd).toBeDefined();

      const spans = store.snapshot(SESSION);
      for (const s of spans) {
        expect(s.events).toBeDefined();
        const match = s.events!.find(
          (evt) =>
            evt.name === "soa.stream.event" &&
            evt.attributes?.["soa.stream.event_id"] === pd!.event_id
        );
        expect(match).toBeDefined();
      }
    } finally {
      await ctx.app.close();
    }
  });

  it("custom observability.requiredResourceAttrs override the §14.4 defaults", async () => {
    const store = new OtelSpanStore();
    const emitter = new OtelEmitter({
      store,
      agentName: "test-agent",
      agentVersion: "1.0.0",
      billingTag: "",
      requiredResourceAttrs: ["service.name", "soa.agent.name", "custom.operator.tag"],
      clock: () => FROZEN_NOW
    });
    const ctx = await buildApp(store, emitter);
    try {
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:cccc333333333333333333333333333333333333333333333333333333333333"
        }
      });
      const [turn] = store.snapshot(SESSION);
      expect(Object.keys(turn!.resource_attributes)).toEqual([
        "service.name",
        "soa.agent.name",
        "custom.operator.tag"
      ]);
      expect(turn!.resource_attributes["custom.operator.tag"]).toBe(""); // unknown → empty stub
    } finally {
      await ctx.app.close();
    }
  });

  it("/observability/otel-spans/recent reads the spans populated by the decision path", async () => {
    const store = new OtelSpanStore();
    const emitter = new OtelEmitter({
      store,
      agentName: "test-agent",
      agentVersion: "1.0.0",
      billingTag: "conformance-test",
      clock: () => FROZEN_NOW
    });
    // Build BOTH plugins against the same store so we exercise the
    // no-duplicate-transport path.
    const sessionStore = new InMemorySessionStore();
    sessionStore.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
    ]);
    const streamEmitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const app = fastify();
    await app.register(permissionsDecisionsPlugin, {
      registry,
      sessionStore,
      chain,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      activeCapability: "WorkspaceWrite",
      runnerVersion: "1.0",
      emitter: streamEmitter,
      otelEmitter: emitter
    });
    const { otelSpansRecentPlugin } = await import("../src/observability/index.js");
    await app.register(otelSpansRecentPlugin, {
      store,
      sessionStore,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      runnerVersion: "1.0"
    });
    try {
      await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:dddd444444444444444444444444444444444444444444444444444444444444"
        }
      });
      const res = await app.inject({
        method: "GET",
        url: `/observability/otel-spans/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spans).toHaveLength(2);
      expect(body.spans.map((s: { name: string }) => s.name).sort()).toEqual(
        ["soa.tool.fs__read_file", "soa.turn"]
      );
      expect(schemas["otel-spans-recent-response"](body)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("no otelEmitter wired: decision flow unchanged; /observability/otel-spans/recent returns empty (backwards-compat)", async () => {
    const store = new OtelSpanStore();
    // No emitter passed into buildApp.
    const ctx = await buildApp(store, undefined);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:eeee555555555555555555555555555555555555555555555555555555555555"
        }
      });
      expect(res.statusCode).toBe(201);
      expect(store.snapshot(SESSION)).toHaveLength(0);
    } finally {
      await ctx.app.close();
    }
  });
});
