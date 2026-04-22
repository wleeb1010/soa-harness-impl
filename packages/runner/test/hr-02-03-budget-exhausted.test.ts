import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { BudgetTracker } from "../src/budget/index.js";

// T-13 HR-02 + HR-03 / SV-BUD-02..07 — §13.2 BudgetExhausted termination.
//
// HR-02 (projection-over-budget pre-call):
//   POST /permissions/decisions with a session whose p95 * 1.15
//   projection + cumulative tokens would exceed maxTokensPerRun is
//   refused with 403 budget-exhausted BEFORE any hook spawns or audit
//   rows land. The session is terminated with
//   SessionEnd{stop_reason:"BudgetExhausted"} and its bearer revoked.
//
// HR-03 (actual-over mid-stream):
//   A decision whose recordTurn push crosses cumulative >= max returns
//   201 for that turn (it completed cleanly) but immediately terminates
//   the session — SessionEnd emits + bearer revokes. The NEXT request
//   from the same bearer is rejected at auth (session record dropped).

const FROZEN_NOW = new Date("2026-04-22T04:00:00.000Z");
const SESSION = "ses_budgetexhaustedfix001";
const BEARER = "budget-exhausted-bearer";

async function buildApp(budgetTracker: BudgetTracker) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
  ]);
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore: store,
    chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    emitter,
    budgetTracker,
    budgetPerTurnEstimate: 1000
  });
  return { app, store, chain, emitter, budgetTracker };
}

describe("HR-02 — projection-over-budget pre-call termination (§13.2)", () => {
  it("wouldExhaust=true at call time: 403 budget-exhausted, SessionEnd{BudgetExhausted}, bearer revoked, no audit row", async () => {
    // maxTokensPerRun=5000, projectionWindow=10. Pre-seed 3 turns at
    // 4500 tokens each → cumulative 13500 already past max; projection
    // would exhaust by a mile.
    const bt = new BudgetTracker({ maxTokensPerRun: 5000 });
    bt.initFor(SESSION);
    bt.recordTurn(SESSION, { actual_total_tokens: 4500 });
    bt.recordTurn(SESSION, { actual_total_tokens: 4500 });
    bt.recordTurn(SESSION, { actual_total_tokens: 4500 });
    expect(bt.wouldExhaust(SESSION)).toBe(true);

    const ctx = await buildApp(bt);
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
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toBe("budget-exhausted");

      // SessionEnd emitted.
      const events = ctx.emitter.snapshot(SESSION);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("SessionEnd");
      expect((events[0]?.payload as Record<string, unknown>).stop_reason).toBe(
        "BudgetExhausted"
      );

      // Session dropped + bearer revoked.
      expect(ctx.store.exists(SESSION)).toBe(false);
      expect(ctx.store.validate(SESSION, BEARER)).toBe(false);

      // No audit row — the enforcement fires before any decision work.
      expect(ctx.chain.snapshot()).toHaveLength(0);

      // BudgetTracker state removed so future sessions reusing this id
      // (rare but possible) start fresh.
      expect(ctx.budgetTracker.has(SESSION)).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });

  it("wouldExhaust=false at call time: normal 201 flow, no SessionEnd", async () => {
    // Plenty of headroom: max=200k, a single 1k turn.
    const bt = new BudgetTracker();
    bt.initFor(SESSION);
    bt.recordTurn(SESSION, { actual_total_tokens: 1000 });
    expect(bt.wouldExhaust(SESSION)).toBe(false);

    const ctx = await buildApp(bt);
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

      const events = ctx.emitter.snapshot(SESSION);
      // PermissionDecision only — no SessionEnd.
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision"]);
      expect(ctx.store.exists(SESSION)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("session not yet in tracker: guard is inert (session fresh-bootstrapped without a recordTurn yet)", async () => {
    const bt = new BudgetTracker();
    // Intentionally DO NOT call initFor or recordTurn — the session has
    // never been touched by the budget path. The pre-call guard must not
    // terminate it simply because getProjection would return undefined.
    const ctx = await buildApp(bt);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:cccc333333333333333333333333333333333333333333333333333333333333"
        }
      });
      expect(res.statusCode).toBe(201);
      expect(ctx.emitter.snapshot(SESSION).some((e) => e.type === "SessionEnd")).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });
});

describe("HR-03 — actual-over-budget mid-stream termination (§13.2)", () => {
  it("recordTurn pushes cumulative >= max: 201 for this turn, then SessionEnd; next request fails at auth", async () => {
    // Design constraint: we want pre-call projection to PASS and
    // post-commit actual-over to FIRE. With default settings, cold-start
    // baseline is 4096 so pre-call projection is 4096 + cumulative. To
    // land the post-commit over-cap check, we size budgetPerTurnEstimate
    // so cumulative + estimate >= max.
    const bt = new BudgetTracker({ maxTokensPerRun: 10_000, projectionWindow: 3 });
    bt.initFor(SESSION);
    // Two small prior turns keep p95 low (cold-start still active: <3 samples).
    bt.recordTurn(SESSION, { actual_total_tokens: 100 });
    bt.recordTurn(SESSION, { actual_total_tokens: 100 });
    expect(bt.wouldExhaust(SESSION)).toBe(false);

    // Budget per turn estimate that, when added to cumulative 200, lands
    // at exactly 10_200 — past the 10_000 cap. Pre-call projection uses
    // cold-start baseline (<3 samples) = max(2048, 4096) = 4096, plus
    // cumulative 200 = 4296 < 10_000 → pre-call passes.
    const ctx = await buildPostCommitApp(bt, 9_900);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:dddd444444444444444444444444444444444444444444444444444444444444"
        }
      });
      // Current turn succeeds (201 AutoAllow) — it completed before the
      // post-commit check.
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");

      // SessionEnd{BudgetExhausted} emitted AFTER the decision but before
      // the response returned — stream now has PermissionDecision +
      // SessionEnd on monotonic sequence.
      const events = ctx.emitter.snapshot(SESSION);
      const types = events.map((e) => e.type);
      expect(types).toContain("PermissionDecision");
      expect(types).toContain("SessionEnd");
      const endEvt = events.find((e) => e.type === "SessionEnd");
      expect((endEvt?.payload as Record<string, unknown>).stop_reason).toBe(
        "BudgetExhausted"
      );

      // Session dropped; next request fails at auth.
      expect(ctx.store.exists(SESSION)).toBe(false);
      const retry = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:ffff666666666666666666666666666666666666666666666666666666666666"
        }
      });
      expect(retry.statusCode).toBe(404);
      expect(JSON.parse(retry.body).error).toBe("unknown-session");
    } finally {
      await ctx.app.close();
    }
  });

  it("turn stays under cap: no SessionEnd, session continues", async () => {
    const bt = new BudgetTracker({ maxTokensPerRun: 200_000, projectionWindow: 3 });
    bt.initFor(SESSION);
    const ctx = await buildPostCommitApp(bt, 500);
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
      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision"]);
      expect(ctx.store.exists(SESSION)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });
});

// Helper for HR-03 — parameterize the per-turn estimate so the test
// can land exactly on the post-commit-over case without relying on
// default 512.
async function buildPostCommitApp(budgetTracker: BudgetTracker, perTurnEstimate: number) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
  ]);
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore: store,
    chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    emitter,
    budgetTracker,
    budgetPerTurnEstimate: perTurnEstimate
  });
  return { app, store, chain, emitter, budgetTracker };
}
