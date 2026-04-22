import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fastify } from "fastify";
import {
  permissionsDecisionsPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { HookReentrancyTracker } from "../src/hook/index.js";

// Finding N / SV-HOOK-08 — hook reentrancy guard.
//
// Behavior contract:
//   - /permissions/decisions requests carrying `x-soa-hook-pid: <pid>` where
//     `<pid>` is a currently-tracked in-flight hook child are rejected with
//     403 {error: "PermissionDenied", reason: "hook-reentrancy"}.
//   - The owning session (the one whose hook is misbehaving, not
//     necessarily the body.session_id) is terminated with
//     SessionEnd{stop_reason: "HookReentrancy"} on the emitter.
//   - The owning session's bearer is revoked via SessionStore.revoke().
//   - Requests without the header, OR with a stale PID no longer in the
//     tracker, OR with a malformed PID, pass the guard and continue
//     through normal auth / readiness / resolver gates.

const here = dirname(fileURLToPath(import.meta.url));
const FROZEN_NOW = new Date("2026-04-22T03:00:00.000Z");
const SESSION = "ses_reentryfixture00000001";
const BEARER = "reentrancy-bearer";

describe("HookReentrancyTracker — unit (Finding N bookkeeping)", () => {
  it("begin/end + sessionForPid round-trip", () => {
    const t = new HookReentrancyTracker();
    expect(t.isEmpty()).toBe(true);
    t.begin(SESSION, 12345);
    expect(t.isInFlight(12345)).toBe(true);
    expect(t.sessionForPid(12345)).toBe(SESSION);
    expect(t.isEmpty()).toBe(false);
    t.end(SESSION, 12345);
    expect(t.isInFlight(12345)).toBe(false);
    expect(t.sessionForPid(12345)).toBeNull();
    expect(t.isEmpty()).toBe(true);
  });

  it("multiple concurrent hooks for one session + sessions cross-independence", () => {
    const t = new HookReentrancyTracker();
    t.begin("ses_A_reentryfixture0001", 100);
    t.begin("ses_A_reentryfixture0001", 101);
    t.begin("ses_B_reentryfixture0002", 200);
    expect(t.snapshot()).toHaveLength(3);
    expect(t.sessionForPid(100)).toBe("ses_A_reentryfixture0001");
    expect(t.sessionForPid(200)).toBe("ses_B_reentryfixture0002");
    t.end("ses_A_reentryfixture0001", 100);
    // Session A still has pid 101 tracked.
    expect(t.sessionForPid(101)).toBe("ses_A_reentryfixture0001");
    t.end("ses_A_reentryfixture0001", 101);
    expect(t.isInFlight(100)).toBe(false);
    expect(t.isInFlight(101)).toBe(false);
    // Session B unaffected.
    expect(t.isInFlight(200)).toBe(true);
  });

  it("end(unknown pid) is a no-op", () => {
    const t = new HookReentrancyTracker();
    t.begin(SESSION, 12345);
    t.end(SESSION, 99999); // unknown
    expect(t.isInFlight(12345)).toBe(true);
  });
});

async function buildApp(tracker: HookReentrancyTracker | undefined) {
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
    ...(tracker !== undefined ? { hookReentrancy: tracker } : {})
  });
  return { app, store, chain, emitter };
}

describe("§15 decisions-route reentrancy guard — integration", () => {
  it("header matching an in-flight hook PID: 403 hook-reentrancy + SessionEnd + bearer revoked", async () => {
    const tracker = new HookReentrancyTracker();
    // Simulate an in-flight PreToolUse child spawned by an earlier (still
    // pending) decision for SESSION.
    const trackedPid = 424242;
    tracker.begin(SESSION, trackedPid);

    const ctx = await buildApp(tracker);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "x-soa-hook-pid": String(trackedPid)
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:aaaa111111111111111111111111111111111111111111111111111111111111"
        }
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toBe("hook-reentrancy");

      // SessionEnd{HookReentrancy} emitted for the owning session.
      const events = ctx.emitter.snapshot(SESSION);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("SessionEnd");
      expect((events[0]?.payload as Record<string, unknown>).stop_reason).toBe(
        "HookReentrancy"
      );

      // Bearer revoked — subsequent request fails at auth (bearer doesn't
      // validate against a dropped session record).
      expect(ctx.store.validate(SESSION, BEARER)).toBe(false);
      expect(ctx.store.exists(SESSION)).toBe(false);

      // No audit row appended (the reentrancy rejection short-circuits
      // BEFORE the resolver / chain.append path).
      expect(ctx.chain.snapshot()).toHaveLength(0);
    } finally {
      await ctx.app.close();
    }
  });

  it("header with stale PID (not in tracker): passes through to normal decision flow", async () => {
    const tracker = new HookReentrancyTracker();
    // Tracker is empty; no in-flight hook. Header PID is just noise.
    const ctx = await buildApp(tracker);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "x-soa-hook-pid": "99999"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbb222222222222222222222222222222222222222222222222222222222222"
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");
      // Session still live.
      expect(ctx.store.exists(SESSION)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("no header at all: normal decision flow", async () => {
    const tracker = new HookReentrancyTracker();
    tracker.begin(SESSION, 424242); // other hook in flight but no header present
    const ctx = await buildApp(tracker);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:cccc333333333333333333333333333333333333333333333333333333333333"
        }
      });
      expect(res.statusCode).toBe(201);
      // Session still live; unrelated in-flight hook continues untouched.
      expect(tracker.isInFlight(424242)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("malformed header value (non-numeric): treated as absent, normal flow", async () => {
    const tracker = new HookReentrancyTracker();
    tracker.begin(SESSION, 424242);
    const ctx = await buildApp(tracker);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "x-soa-hook-pid": "not-a-number"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:dddd444444444444444444444444444444444444444444444444444444444444"
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });

  it("no tracker wired: reentrancy guard disabled (backwards-compat)", async () => {
    const ctx = await buildApp(undefined);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "x-soa-hook-pid": "424242"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:eeee555555555555555555555555555555555555555555555555555555555555"
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });

  it("cross-session reentrancy: hook-for-A calls back claiming body.session_id=B → A terminated, B untouched", async () => {
    const tracker = new HookReentrancyTracker();
    // Session A exists in store; register a second session B too.
    const ctx = await buildApp(tracker);
    const SESSION_B = "ses_reentryBsession000001";
    const BEARER_B = "reentrancy-B-bearer";
    ctx.store.register(SESSION_B, BEARER_B, { activeMode: "WorkspaceWrite", canDecide: true });
    // In-flight hook belongs to SESSION (the A session).
    tracker.begin(SESSION, 77777);
    try {
      // Request body claims B; header names the A hook's PID.
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER_B}`,
          "content-type": "application/json",
          "x-soa-hook-pid": "77777"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION_B,
          args_digest: "sha256:ffff666666666666666666666666666666666666666666666666666666666666"
        }
      });
      expect(res.statusCode).toBe(403);
      // A terminated (owns the hook), B untouched.
      expect(ctx.store.exists(SESSION)).toBe(false);
      expect(ctx.store.exists(SESSION_B)).toBe(true);
      const endsOnA = ctx.emitter.snapshot(SESSION);
      expect(endsOnA).toHaveLength(1);
      expect(endsOnA[0]?.type).toBe("SessionEnd");
      expect((endsOnA[0]?.payload as Record<string, unknown>).stop_reason).toBe(
        "HookReentrancy"
      );
      // B's stream is empty — the cross-session attack doesn't pollute B's
      // timeline.
      expect(ctx.emitter.snapshot(SESSION_B)).toHaveLength(0);
    } finally {
      await ctx.app.close();
    }
  });
});

describe("runHook + HookReentrancyTracker — balanced begin/end lifecycle", () => {
  it("allow fixture: onSpawn fires with pid, onExit fires once; tracker empty after", async () => {
    const { runHook } = await import("../src/hook/index.js");
    const tracker = new HookReentrancyTracker();
    const fixtures = join(here, "fixtures", "hooks");
    let observedPid: number | null = null;
    let exitCount = 0;
    await runHook({
      command: [process.execPath, join(fixtures, "allow.mjs")],
      stdin: {
        hook: "PreToolUse",
        session_id: SESSION,
        turn_id: "turn_reentry00",
        tool: {
          name: "fs__read_file",
          risk_class: "ReadOnly",
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        },
        capability: "ReadOnly",
        handler: "Interactive"
      },
      onSpawn: (pid) => {
        observedPid = pid;
        tracker.begin(SESSION, pid);
      },
      onExit: () => {
        exitCount++;
        if (observedPid !== null) tracker.end(SESSION, observedPid);
      }
    });
    expect(observedPid).not.toBeNull();
    expect(exitCount).toBe(1);
    expect(tracker.isEmpty()).toBe(true);
  });

  it("crashed hook (exit 1 via fixture): onExit still fires exactly once; tracker empty", async () => {
    const { runHook } = await import("../src/hook/index.js");
    const tracker = new HookReentrancyTracker();
    const fixtures = join(here, "fixtures", "hooks");
    let observedPid: number | null = null;
    let exitCount = 0;
    await runHook({
      command: [process.execPath, join(fixtures, "deny.mjs")],
      stdin: {
        hook: "PreToolUse",
        session_id: SESSION,
        turn_id: "turn_reentry01",
        tool: {
          name: "fs__read_file",
          risk_class: "ReadOnly",
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        },
        capability: "ReadOnly",
        handler: "Interactive"
      },
      onSpawn: (pid) => {
        observedPid = pid;
        tracker.begin(SESSION, pid);
      },
      onExit: () => {
        exitCount++;
        if (observedPid !== null) tracker.end(SESSION, observedPid);
      }
    });
    expect(exitCount).toBe(1);
    expect(tracker.isEmpty()).toBe(true);
  });
});
