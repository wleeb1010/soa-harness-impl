import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  parseConsolidationEnv,
  assertConsolidationHooksListenerSafe,
  ConsolidationHookOnPublicListener
} from "../src/memory/index.js";
import {
  parseSyntheticCacheHitEnv,
  assertSyntheticCacheHitListenerSafe,
  SyntheticCacheHitOnPublicListener
} from "../src/budget/index.js";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { BudgetTracker } from "../src/budget/index.js";

// Finding AC / §8.4.1 — consolidation env hooks.
// Finding AD / SV-BUD-04 — synthetic cache-hit env hook.

const FROZEN_NOW = new Date("2026-04-22T15:00:00.000Z");

describe("Finding AC — §8.4.1 consolidation env-hook parser + guard", () => {
  it("parseConsolidationEnv: both unset → empty config", () => {
    expect(parseConsolidationEnv({})).toEqual({});
  });

  it("parseConsolidationEnv: RUNNER_CONSOLIDATION_TICK_MS=1000 → tickIntervalMs:1000", () => {
    expect(parseConsolidationEnv({ RUNNER_CONSOLIDATION_TICK_MS: "1000" })).toEqual({
      tickIntervalMs: 1000
    });
  });

  it("parseConsolidationEnv: RUNNER_CONSOLIDATION_ELAPSED_MS=0 → intervalMs:0", () => {
    expect(parseConsolidationEnv({ RUNNER_CONSOLIDATION_ELAPSED_MS: "0" })).toEqual({
      intervalMs: 0
    });
  });

  it("parseConsolidationEnv: invalid (non-integer, negative) → throws", () => {
    expect(() => parseConsolidationEnv({ RUNNER_CONSOLIDATION_TICK_MS: "not-a-number" })).toThrow(
      /positive integer/
    );
    expect(() => parseConsolidationEnv({ RUNNER_CONSOLIDATION_TICK_MS: "0" })).toThrow(
      /positive integer/
    );
    expect(() => parseConsolidationEnv({ RUNNER_CONSOLIDATION_ELAPSED_MS: "-1" })).toThrow(
      /non-negative integer/
    );
  });

  it("assertConsolidationHooksListenerSafe: no env set → no throw on any host", () => {
    expect(() =>
      assertConsolidationHooksListenerSafe({ env: {}, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("assertConsolidationHooksListenerSafe: env set + loopback → allowed", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(() =>
        assertConsolidationHooksListenerSafe({ env: { tickIntervalMs: 100 }, host })
      ).not.toThrow();
    }
  });

  it("assertConsolidationHooksListenerSafe: env set + non-loopback → ConsolidationHookOnPublicListener", () => {
    expect(() =>
      assertConsolidationHooksListenerSafe({
        env: { tickIntervalMs: 100 },
        host: "0.0.0.0"
      })
    ).toThrow(ConsolidationHookOnPublicListener);
    expect(() =>
      assertConsolidationHooksListenerSafe({
        env: { intervalMs: 1000 },
        host: "192.168.1.5"
      })
    ).toThrow(ConsolidationHookOnPublicListener);
  });
});

describe("Finding AD — synthetic cache-hit env-hook parser + guard", () => {
  it("parseSyntheticCacheHitEnv: unset → {}", () => {
    expect(parseSyntheticCacheHitEnv({})).toEqual({});
  });

  it("parseSyntheticCacheHitEnv: set to valid non-negative integer → value", () => {
    expect(parseSyntheticCacheHitEnv({ RUNNER_SYNTHETIC_CACHE_HIT: "42" })).toEqual({
      value: 42
    });
    expect(parseSyntheticCacheHitEnv({ RUNNER_SYNTHETIC_CACHE_HIT: "0" })).toEqual({
      value: 0
    });
  });

  it("parseSyntheticCacheHitEnv: invalid → throws", () => {
    expect(() => parseSyntheticCacheHitEnv({ RUNNER_SYNTHETIC_CACHE_HIT: "junk" })).toThrow(
      /non-negative integer/
    );
    expect(() => parseSyntheticCacheHitEnv({ RUNNER_SYNTHETIC_CACHE_HIT: "-3" })).toThrow(
      /non-negative integer/
    );
  });

  it("assertSyntheticCacheHitListenerSafe: disabled → always allowed", () => {
    expect(() =>
      assertSyntheticCacheHitListenerSafe({ cfg: {}, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("assertSyntheticCacheHitListenerSafe: set + loopback → allowed; non-loopback → SyntheticCacheHitOnPublicListener", () => {
    expect(() =>
      assertSyntheticCacheHitListenerSafe({ cfg: { value: 100 }, host: "127.0.0.1" })
    ).not.toThrow();
    expect(() =>
      assertSyntheticCacheHitListenerSafe({ cfg: { value: 100 }, host: "0.0.0.0" })
    ).toThrow(SyntheticCacheHitOnPublicListener);
  });

  it("decisions-route integration: syntheticCacheHit stamps both cache fields on each recordTurn", async () => {
    const store = new InMemorySessionStore();
    const SESSION = "ses_syntheticcachefix0001";
    const BEARER = "sc-bearer";
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
    ]);
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const tracker = new BudgetTracker({ maxTokensPerRun: 200_000 });
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
      budgetPerTurnEstimate: 1000,
      syntheticCacheHit: 250
    });
    try {
      const res = await app.inject({
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
      const snap = tracker.getProjection(SESSION)!;
      expect(snap.cache_accounting!.prompt_tokens_cached).toBe(250);
      expect(snap.cache_accounting!.completion_tokens_cached).toBe(250);

      // Another decision — totals accumulate.
      await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbb222222222222222222222222222222222222222222222222222222222222"
        }
      });
      const snap2 = tracker.getProjection(SESSION)!;
      expect(snap2.cache_accounting!.prompt_tokens_cached).toBe(500);
      expect(snap2.cache_accounting!.completion_tokens_cached).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("decisions-route with syntheticCacheHit UNSET: cache totals stay at 0 (M3 default)", async () => {
    const store = new InMemorySessionStore();
    const SESSION = "ses_synthhitunset0000001";
    const BEARER = "sc-unset-bearer";
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
    ]);
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const tracker = new BudgetTracker({ maxTokensPerRun: 200_000 });
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
    try {
      await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:cccc333333333333333333333333333333333333333333333333333333333333"
        }
      });
      const snap = tracker.getProjection(SESSION)!;
      expect(snap.cache_accounting!.prompt_tokens_cached).toBe(0);
      expect(snap.cache_accounting!.completion_tokens_cached).toBe(0);
    } finally {
      await app.close();
    }
  });
});
