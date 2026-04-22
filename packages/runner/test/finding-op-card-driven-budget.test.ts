import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { BudgetTracker } from "../src/budget/index.js";

// Finding O (SV-BUD-02) + Finding P (SV-BUD-04) — post-pin-bump
// impl contract:
//   - maxTokensPerRun comes from the Agent Card (card.tokenBudget.
//     maxTokensPerRun) — NOT hardcoded. The bin wires this at
//     start-up; the plugin just consumes whatever BudgetTracker
//     was constructed with.
//   - Every recordTurn carries prompt_tokens_cached + completion_
//     tokens_cached (zero when uncached). /budget/projection's
//     cache_accounting totals advance in lockstep so the validator's
//     SV-BUD-04 probe reads a deterministic shape.

const FROZEN_NOW = new Date("2026-04-22T05:00:00.000Z");
const SESSION = "ses_opbudgetfixture0000001";
const BEARER = "op-budget-bearer";

describe("Finding O / SV-BUD-02 — BudgetTracker honors a card-supplied maxTokensPerRun", () => {
  it("construction: caller-supplied maxTokensPerRun is authoritative (no 200_000 default override)", () => {
    const cardMax = 7_500;
    const bt = new BudgetTracker({ maxTokensPerRun: cardMax });
    bt.initFor(SESSION);
    // A single recordTurn just under cardMax leaves projection under cap.
    bt.recordTurn(SESSION, { actual_total_tokens: 500 });
    const snap = bt.getProjection(SESSION);
    expect(snap?.max_tokens_per_run).toBe(cardMax);
  });

  it("wouldExhaust flips correctly against a small card-driven max", () => {
    // Card says 5000; after a few large turns the projection crosses it.
    const bt = new BudgetTracker({ maxTokensPerRun: 5_000, projectionWindow: 3 });
    bt.initFor(SESSION);
    expect(bt.wouldExhaust(SESSION)).toBe(false);
    bt.recordTurn(SESSION, { actual_total_tokens: 2000 });
    bt.recordTurn(SESSION, { actual_total_tokens: 2000 });
    bt.recordTurn(SESSION, { actual_total_tokens: 2000 });
    // Now cumulative=6000 >= 5000 AND projection (p95≈2000*1.15=2300)
    // pushes further over. Both HR-02 + HR-03 paths fire.
    expect(bt.wouldExhaust(SESSION)).toBe(true);
  });
});

describe("Finding P / SV-BUD-04 — recordTurn populates cache accounting", () => {
  async function newApp(tracker: BudgetTracker) {
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
      budgetTracker: tracker,
      budgetPerTurnEstimate: 1000
    });
    return { app, store, chain, emitter, tracker };
  }

  it("each committed decision records cache fields (zero in M3 no-dispatcher)", async () => {
    const bt = new BudgetTracker({ maxTokensPerRun: 50_000 });
    bt.initFor(SESSION);
    const ctx = await newApp(bt);
    try {
      for (const digest of [
        "sha256:aaaa111111111111111111111111111111111111111111111111111111111111",
        "sha256:bbbb222222222222222222222222222222222222222222222222222222222222",
        "sha256:cccc333333333333333333333333333333333333333333333333333333333333"
      ]) {
        const r = await ctx.app.inject({
          method: "POST",
          url: "/permissions/decisions",
          headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
          payload: { tool: "fs__read_file", session_id: SESSION, args_digest: digest }
        });
        expect(r.statusCode).toBe(201);
      }
      const snap = ctx.tracker.getProjection(SESSION);
      expect(snap).toBeDefined();
      // Both cache-accounting totals are present + non-undefined
      // (the whole point of Finding P — never leave the validator
      // reading an absent field).
      expect(snap!.cache_accounting).toBeDefined();
      expect(snap!.cache_accounting!.prompt_tokens_cached).toBe(0);
      expect(snap!.cache_accounting!.completion_tokens_cached).toBe(0);
      // Cumulative matches 3 * budgetPerTurnEstimate.
      expect(snap!.cumulative_tokens_consumed).toBe(3000);
    } finally {
      await ctx.app.close();
    }
  });
});
