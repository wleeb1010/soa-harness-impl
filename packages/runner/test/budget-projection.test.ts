import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { budgetProjectionPlugin } from "../src/observability/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import { BudgetTracker, percentile95 } from "../src/budget/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T22:00:00.000Z");
const SESSION = "ses_budgetfixture000001a";
const BEARER = "budget-test-bearer";

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
  preRegister?: boolean;
  tracker?: BudgetTracker;
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
      : {}),
    ...(overrides.tracker !== undefined ? { tracker: overrides.tracker } : {})
  });
  return { app, store };
}

describe("GET /budget/projection — §13.5 (T-3 scaffold + T-4 tracker)", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("T-3 scaffold: query-param form returns cold-start placeholder when no tracker wired", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection?session_id=${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const validator = schemaRegistry["budget-projection-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);
    expect(body["safety_factor"]).toBe(1.15);
    expect(body["cold_start_baseline_active"]).toBe(true);
    expect(body["cumulative_tokens_consumed"]).toBe(0);
  });

  it("T-3 scaffold: back-compat path-param form still returns 200", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it("T-4: tracker with recorded turns projects p95 * 1.15 ceiling", async () => {
    const tracker = new BudgetTracker({ projectionWindow: 10, maxTokensPerRun: 200_000 });
    tracker.initFor(SESSION);
    // Record 4 turns so we exit cold-start (need >= 3 samples for p95).
    [1000, 1200, 900, 1500].forEach((tokens) => tracker.recordTurn(SESSION, { actual_total_tokens: tokens }));

    const app = await newApp({ tracker });
    try {
      const res = await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        cold_start_baseline_active: boolean;
        p95_tokens_per_turn_over_window_w: number;
        cumulative_tokens_consumed: number;
        projected_tokens_remaining: number;
        projection_headroom?: number;
      };
      expect(body.cold_start_baseline_active).toBe(false);
      expect(body.cumulative_tokens_consumed).toBe(4600);
      expect(body.projected_tokens_remaining).toBe(200_000 - 4600);
      // p95 of [900, 1000, 1200, 1500] = 1500 - 0.05*(1500-1200) = 1485
      expect(body.p95_tokens_per_turn_over_window_w).toBeCloseTo(1455, 0);
      // headroom ≈ floor(195400 / ceil(1455*1.15)) = floor(195400 / 1674) = 116-117
      expect(body.projection_headroom).toBeGreaterThan(100);
    } finally {
      await app.app.close();
    }
  });

  it("T-4: cache_accounting surfaces prompt + completion cached tokens", async () => {
    const tracker = new BudgetTracker();
    tracker.initFor(SESSION);
    tracker.recordTurn(SESSION, {
      actual_total_tokens: 1000,
      prompt_tokens_cached: 500,
      completion_tokens_cached: 50
    });
    tracker.recordTurn(SESSION, {
      actual_total_tokens: 800,
      prompt_tokens_cached: 200
    });

    const app = await newApp({ tracker });
    try {
      const res = await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const body = JSON.parse(res.body) as {
        cache_accounting: { prompt_tokens_cached: number; completion_tokens_cached: number };
      };
      expect(body.cache_accounting.prompt_tokens_cached).toBe(700);
      expect(body.cache_accounting.completion_tokens_cached).toBe(50);
    } finally {
      await app.app.close();
    }
  });

  it("T-4: wouldExhaust triggers once cumulative + next-projection would exceed max", async () => {
    const tracker = new BudgetTracker({ projectionWindow: 10, maxTokensPerRun: 10_000 });
    tracker.initFor(SESSION);
    [8000].forEach((t) => tracker.recordTurn(SESSION, { actual_total_tokens: t }));
    // Still < 3 samples → cold-start baseline = 4096. 8000 + 4096 > 10000 → exhaust.
    expect(tracker.wouldExhaust(SESSION)).toBe(true);

    const fresh = new BudgetTracker({ projectionWindow: 10, maxTokensPerRun: 100_000 });
    fresh.initFor(SESSION);
    expect(fresh.wouldExhaust(SESSION)).toBe(false); // cold-start within budget
  });

  it("byte-identity: two reads of a stable tracker are byte-equal excluding generated_at", async () => {
    const tracker = new BudgetTracker();
    tracker.initFor(SESSION);
    tracker.recordTurn(SESSION, { actual_total_tokens: 1000 });
    tracker.recordTurn(SESSION, { actual_total_tokens: 1100 });
    tracker.recordTurn(SESSION, { actual_total_tokens: 900 });

    const app = await newApp({ tracker });
    try {
      const a = await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const aBody = JSON.parse(a.body) as Record<string, unknown>;
      const bBody = JSON.parse(b.body) as Record<string, unknown>;
      delete aBody["generated_at"];
      delete bBody["generated_at"];
      expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
    } finally {
      await app.app.close();
    }
  });

  it("not-a-side-effect: reads do NOT advance the tracker's cumulative count", async () => {
    const tracker = new BudgetTracker();
    tracker.initFor(SESSION);
    tracker.recordTurn(SESSION, { actual_total_tokens: 500 });
    const app = await newApp({ tracker });
    try {
      await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      await app.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(tracker.getProjection(SESSION)?.cumulative_tokens_consumed).toBe(500);
    } finally {
      await app.app.close();
    }
  });

  it("percentile95 unit: known values match expected 95th percentile", () => {
    // Linear-interpolation p95 matches numpy/reporting tooling.
    expect(percentile95([])).toBe(0);
    expect(percentile95([100])).toBe(100);
    expect(percentile95([100, 200])).toBe(195); // 100 + 0.95*(200-100) = 195
    expect(percentile95([900, 1000, 1200, 1500])).toBeCloseTo(1455, 0);
  });

  it("auth + readiness matrix: 400 / 401 / 403 / 404 / 429 / 503", async () => {
    // 401 missing bearer
    const noAuth = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection?session_id=${SESSION}`
    });
    expect(noAuth.statusCode).toBe(401);

    // 400 missing session_id query param
    const noSid = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(noSid.statusCode).toBe(400);

    // 400 bad pattern
    const bad = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection?session_id=bogus`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(bad.statusCode).toBe(400);

    // 404 unknown session
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection?session_id=ses_nonexistentfixture01`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknown.statusCode).toBe(404);

    // 403 wrong bearer
    const wrong = await ctx.app.inject({
      method: "GET",
      url: `/budget/projection?session_id=${SESSION}`,
      headers: { authorization: `Bearer nope` }
    });
    expect(wrong.statusCode).toBe(403);

    // 429 rate-limit
    const small = await newApp({ requestsPerMinute: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: `/budget/projection?session_id=${SESSION}`,
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
        url: `/budget/projection?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await preBoot.app.close();
    }
  });

  it("BudgetTracker rejects non-1.15 safety_factor (§13.1 pin)", () => {
    expect(() => new BudgetTracker({ safetyFactor: 2.0 as unknown as 1.15 })).toThrow(/1\.15/);
  });

  it("ring-buffer evicts oldest turns past projectionWindow", () => {
    const tracker = new BudgetTracker({ projectionWindow: 3, maxTokensPerRun: 100_000 });
    tracker.initFor(SESSION);
    [100, 200, 300, 400, 500].forEach((t) => tracker.recordTurn(SESSION, { actual_total_tokens: t }));
    const snap = tracker.getProjection(SESSION)!;
    // Cumulative counts ALL turns (not just windowed); ring affects only p95.
    expect(snap.cumulative_tokens_consumed).toBe(1500);
    // p95 over window [300, 400, 500] with linear interpolation = 490
    expect(snap.p95_tokens_per_turn_over_window_w).toBeCloseTo(490, 0);
  });
});
