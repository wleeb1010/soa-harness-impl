import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { budgetProjectionPlugin } from "../src/observability/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T22:00:00.000Z");
const SESSION = "ses_budgetfixture000001a";
const BEARER = "budget-test-bearer";

function buildReadiness(reason: string | null): ReadinessProbe {
  return { check: () => reason as ReadinessProbe["check"] extends () => infer R ? R : never };
}

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
  preRegister?: boolean;
} = {}) {
  const app = fastify();
  const store = new InMemorySessionStore();
  if (overrides.preRegister !== false) {
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite" });
  }
  await app.register(budgetProjectionPlugin, {
    sessionStore: store,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, store };
}

describe("GET /budget/projection/:session_id — §13.5 scaffold (M3-T3)", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("happy path: 200 + schema-valid body; cold-start-baseline=true for a quiescent session", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = JSON.parse(res.body) as Record<string, unknown>;
    const validator = schemaRegistry["budget-projection-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);

    expect(body["session_id"]).toBe(SESSION);
    expect(body["safety_factor"]).toBe(1.15);
    expect(body["stop_reason_if_exhausted"]).toBe("BudgetExhausted");
    expect(body["cold_start_baseline_active"]).toBe(true);
    expect(body["cumulative_tokens_consumed"]).toBe(0);
  });

  it("byte-identity: two reads are byte-equal excluding generated_at", async () => {
    const a = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const aBody = JSON.parse(a.body) as Record<string, unknown>;
    const bBody = JSON.parse(b.body) as Record<string, unknown>;
    delete aBody["generated_at"];
    delete bBody["generated_at"];
    expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
  });

  it("auth + readiness matrix: 400 / 401 / 403 / 404 / 429 / 503", async () => {
    // 401 missing bearer
    const noAuth = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`
    });
    expect(noAuth.statusCode).toBe(401);

    // 400 malformed session_id (short)
    const bad = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/nope`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(bad.statusCode).toBe(400);

    // 404 unknown session (valid format, not registered)
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/ses_nonexistentfixture01`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknown.statusCode).toBe(404);

    // 403 wrong bearer
    const wrong = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`,
      headers: { authorization: `Bearer nope-wrong-bearer` }
    });
    expect(wrong.statusCode).toBe(403);

    // 429 rate-limit
    const small = await newApp({ requestsPerMinute: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: `/budget/projection/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: `/budget/projection/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(429);
      expect(b.headers["retry-after"]).toBeDefined();
    } finally {
      await small.app.close();
    }

    // 503 pre-boot readiness
    const preBoot = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    try {
      const r = await preBoot.app.inject({
        method: "GET",
        url: `/budget/projection/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await preBoot.app.close();
    }
  });
});
