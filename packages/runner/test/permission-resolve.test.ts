import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import {
  permissionsResolvePlugin,
  InMemorySessionStore,
  type PermissionsResolveResponse
} from "../src/permission/index.js";
import { ToolRegistry, loadToolRegistry } from "../src/registry/index.js";
import type { ReadinessProbe, ReadinessReason } from "../src/probes/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS_FIXTURE = join(here, "fixtures", "tools.sample.json");

const FROZEN_NOW = new Date("2026-04-20T12:00:00.000Z");
const RUNNER_VERSION = "1.0";

function buildReadiness(reason: ReadinessReason | null): ReadinessProbe {
  return { check: () => reason };
}

async function newApp(
  overrides: {
    registry?: ToolRegistry;
    readiness?: ReadinessProbe;
    activeCapability?: "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
    toolRequirements?: Record<string, "AutoAllow" | "Prompt" | "Deny">;
    policyEndpoint?: string;
    requestsPerMinute?: number;
    sessionStore?: InMemorySessionStore;
  } = {}
) {
  const app = fastify();
  const store = overrides.sessionStore ?? new InMemorySessionStore();
  const registry = overrides.registry ?? loadToolRegistry(TOOLS_FIXTURE);
  await app.register(permissionsResolvePlugin, {
    registry,
    sessionStore: store,
    readiness: overrides.readiness ?? buildReadiness(null),
    clock: () => FROZEN_NOW,
    activeCapability: overrides.activeCapability ?? "WorkspaceWrite",
    ...(overrides.toolRequirements !== undefined ? { toolRequirements: overrides.toolRequirements } : {}),
    ...(overrides.policyEndpoint !== undefined ? { policyEndpoint: overrides.policyEndpoint } : {}),
    ...(overrides.requestsPerMinute !== undefined ? { requestsPerMinute: overrides.requestsPerMinute } : {}),
    runnerVersion: RUNNER_VERSION
  });
  return { app, store, registry };
}

describe("GET /permissions/resolve — auth + shape (§10.3.1)", () => {
  const SESSION = "ses_abc";
  const BEARER = "test-bearer-xyz";
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
    ctx.store.register(SESSION, BEARER);
  });

  it("returns 200 + schema-valid body for a known (tool, session)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=fs__read_file&session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    const validate = schemaRegistry["permissions-resolve-response"];
    expect(validate(body)).toBe(true);
    expect(body.decision).toBe("AutoAllow");
    expect(body.resolved_control).toBe("AutoAllow");
    expect(body.resolved_capability).toBe("WorkspaceWrite");
    expect(body.trace.length).toBeGreaterThanOrEqual(1);
    expect(body.trace.every((t) => t.step >= 1 && t.step <= 5)).toBe(true);
    expect(body.runner_version).toBe(RUNNER_VERSION);
    expect(body.resolved_at).toBe(FROZEN_NOW.toISOString());
  });

  it("returns 401 with no bearer", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=fs__read_file&session_id=${SESSION}`
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 with a bearer that does not match the session", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=fs__read_file&session_id=${SESSION}`,
      headers: { authorization: "Bearer different-bearer" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 for a malformed query (missing params)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=fs__read_file`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown tool", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=unknown__tool&session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an unknown session (before bearer mismatch fires)", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/permissions/resolve?tool=fs__read_file&session_id=ses_unknown`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /permissions/resolve — §10.3 step paths", () => {
  it("decision=Prompt when registry default is Prompt and no toolRequirement", async () => {
    const { app, store } = await newApp({ activeCapability: "WorkspaceWrite" });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__write_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    expect(body.decision).toBe("Prompt");
    expect(body.reason).toBe("prompt-required-by-control");
    expect(body.trace.some((t) => t.step === 2 && t.result === "passed")).toBe(true);
  });

  it("decision=CapabilityDenied when capability cannot host risk_class", async () => {
    const { app, store } = await newApp({ activeCapability: "ReadOnly" });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__delete_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    expect(body.decision).toBe("CapabilityDenied");
    expect(body.reason).toBe("risk-class-not-permitted-under-capability");
    const step2 = body.trace.find((t) => t.step === 2);
    expect(step2?.result).toBe("rejected");
  });

  it("decision=ConfigPrecedenceViolation when toolRequirements loosens default", async () => {
    const { app, store } = await newApp({
      activeCapability: "WorkspaceWrite",
      toolRequirements: { fs__write_file: "AutoAllow" }
    });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__write_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    expect(body.decision).toBe("ConfigPrecedenceViolation");
    expect(body.reason).toBe("toolRequirements-loosens-default");
    const step3 = body.trace.find((t) => t.step === 3);
    expect(step3?.result).toBe("rejected");
  });

  it("trace records step 4 as 'skipped' when policyEndpoint unconfigured", async () => {
    const { app, store } = await newApp({ activeCapability: "WorkspaceWrite" });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    const step4 = body.trace.find((t) => t.step === 4);
    expect(step4?.result).toBe("skipped");
    expect(body.policy_endpoint_applied).toBeUndefined();
  });

  it("reports policy_endpoint_applied=false when policyEndpoint is set (M1 does not invoke)", async () => {
    const { app, store } = await newApp({
      activeCapability: "WorkspaceWrite",
      policyEndpoint: "https://policy.test.local/decide"
    });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const body: PermissionsResolveResponse = JSON.parse(res.body);
    expect(body.policy_endpoint_applied).toBe(false);
    const step4 = body.trace.find((t) => t.step === 4);
    expect(step4?.detail).toContain("policyEndpoint configured");
  });
});

describe("GET /permissions/resolve — rate limit + boot gate", () => {
  it("returns 429 + Retry-After after 60 requests / 60s from the same bearer", async () => {
    const { app, store } = await newApp({ requestsPerMinute: 3 });
    store.register("ses_a", "b");
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({
        method: "GET",
        url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
        headers: { authorization: "Bearer b" }
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("returns 503 {reason} when readiness is pending", async () => {
    const { app, store } = await newApp({ readiness: buildReadiness("bootstrap-pending") });
    store.register("ses_a", "b");
    const res = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("not-ready");
    expect(body.reason).toBe("bootstrap-pending");
  });
});

describe("GET /permissions/resolve — not-a-side-effect property (§10.3.1 MUST)", () => {
  it("two sequential queries leave the session store and registry untouched", async () => {
    const { app, store, registry } = await newApp();
    store.register("ses_a", "b");
    const before = { toolCount: registry.size(), sessionPresent: store.exists("ses_a") };
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "GET",
        url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
        headers: { authorization: "Bearer b" }
      });
    }
    expect(registry.size()).toBe(before.toolCount);
    expect(store.exists("ses_a")).toBe(before.sessionPresent);
    expect(store.validate("ses_a", "b")).toBe(true);
  });

  it("repeated queries produce identical response bodies (idempotent / pure)", async () => {
    const { app, store } = await newApp();
    store.register("ses_a", "b");
    const first = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/permissions/resolve?tool=fs__read_file&session_id=ses_a",
      headers: { authorization: "Bearer b" }
    });
    expect(JSON.parse(first.body)).toEqual(JSON.parse(second.body));
  });
});
