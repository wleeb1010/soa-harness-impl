import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { toolsRegisteredPlugin } from "../src/observability/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T22:00:00.000Z");
const BEARER = "tools-reg-bearer";

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
} = {}) {
  const app = fastify();
  const store = new InMemorySessionStore();
  store.register("ses_toolsregfixture00001", BEARER);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
    { name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" },
    { name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }
  ]);
  await app.register(toolsRegisteredPlugin, {
    registry,
    sessionStore: store,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    registeredAt: FROZEN_NOW,
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, store, registry };
}

describe("GET /tools/registered — §11.4 scaffold (M3-T3)", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("happy path: 200 + schema-valid body; registry_version is JCS(tools) SHA-256", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/tools/registered",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = JSON.parse(res.body) as {
      tools: Array<Record<string, unknown>>;
      registry_version: string;
      runner_version: string;
      generated_at: string;
    };
    const validator = schemaRegistry["tools-registered-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);

    expect(body.tools).toHaveLength(3);
    expect(body.registry_version).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.runner_version).toBe("1.0");
    for (const t of body.tools) {
      expect(t["registration_source"]).toBe("static-fixture");
      expect(t["registered_at"]).toBe(FROZEN_NOW.toISOString());
    }
  });

  it("byte-identity: two reads byte-equal excluding generated_at", async () => {
    const a = await ctx.app.inject({
      method: "GET",
      url: "/tools/registered",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: "/tools/registered",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const aBody = JSON.parse(a.body) as Record<string, unknown>;
    const bBody = JSON.parse(b.body) as Record<string, unknown>;
    delete aBody["generated_at"];
    delete bBody["generated_at"];
    expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
  });

  it("auth + readiness matrix: 401 / 403 / 429 / 503", async () => {
    const noAuth = await ctx.app.inject({ method: "GET", url: "/tools/registered" });
    expect(noAuth.statusCode).toBe(401);

    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/tools/registered",
      headers: { authorization: `Bearer unknown-bearer` }
    });
    expect(wrong.statusCode).toBe(403);

    const small = await newApp({ requestsPerMinute: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: "/tools/registered",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: "/tools/registered",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(429);
    } finally {
      await small.app.close();
    }

    const preBoot = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    try {
      const r = await preBoot.app.inject({
        method: "GET",
        url: "/tools/registered",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await preBoot.app.close();
    }
  });
});
