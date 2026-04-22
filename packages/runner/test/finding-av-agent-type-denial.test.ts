import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";

// Finding AV / HR-07 — §11.2 agentType pool filter. When a Runner
// booted with `card.agentType = "explore"` handles a decision for a
// tool whose risk_class is above ReadOnly, the denial reason MUST be
// the specific `agent-type-insufficient`, not the generic
// capability-denied or unknown-tool reason.

const FROZEN_NOW = new Date("2026-04-22T12:00:00.000Z");
const SESSION = "ses_agentTypeFixture000001";
const BEARER = "agent-type-bearer";

async function newApp(agentType: string | undefined) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
    { name: "fs__write_file", risk_class: "Mutating", default_control: "AutoAllow" },
    { name: "shell__exec", risk_class: "Destructive", default_control: "Prompt" }
  ]);
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore: store,
    chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    ...(agentType !== undefined ? { agentType } : {})
  });
  return { app, store, chain };
}

async function post(app: Awaited<ReturnType<typeof newApp>>["app"], tool: string) {
  return app.inject({
    method: "POST",
    url: "/permissions/decisions",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
    payload: {
      tool,
      session_id: SESSION,
      args_digest: "sha256:" + "a".repeat(64)
    }
  });
}

describe("Finding AV — /permissions/decisions agent-type-insufficient", () => {
  it("explore agentType + ReadOnly tool → allowed (pool contains it)", async () => {
    const ctx = await newApp("explore");
    try {
      const res = await post(ctx.app, "fs__read_file");
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");
    } finally {
      await ctx.app.close();
    }
  });

  it("explore agentType + Mutating tool → 403 agent-type-insufficient (pool filter)", async () => {
    const ctx = await newApp("explore");
    try {
      const res = await post(ctx.app, "fs__write_file");
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; reason: string; detail: string };
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toBe("agent-type-insufficient");
      expect(body.detail).toMatch(/agentType="explore"/);
      expect(body.detail).toMatch(/risk_class="Mutating"/);
      // No audit row — §11.2 pool filter fires before resolver + audit append.
      expect(ctx.chain.snapshot().length).toBe(0);
    } finally {
      await ctx.app.close();
    }
  });

  it("explore agentType + Destructive tool → 403 agent-type-insufficient (not capability-denied)", async () => {
    const ctx = await newApp("explore");
    try {
      const res = await post(ctx.app, "shell__exec");
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("PermissionDenied");
      // §10.3 capability-denied is a legitimate alternative outcome at the
      // resolver layer; §11.2 agentType filter MUST short-circuit earlier
      // so the reason reflects the pool axis, not the capability axis.
      expect(body.reason).toBe("agent-type-insufficient");
    } finally {
      await ctx.app.close();
    }
  });

  it("general-purpose agentType + Mutating tool → resolver runs normally (no pool filter)", async () => {
    const ctx = await newApp("general-purpose");
    try {
      const res = await post(ctx.app, "fs__write_file");
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");
    } finally {
      await ctx.app.close();
    }
  });

  it("agentType unset → pool filter inert (back-compat with pre-AV callers)", async () => {
    const ctx = await newApp(undefined);
    try {
      const res = await post(ctx.app, "fs__write_file");
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });

  it("unknown tool still returns 404 unknown-tool (not agent-type-insufficient)", async () => {
    const ctx = await newApp("explore");
    try {
      const res = await post(ctx.app, "tool__does_not_exist");
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("unknown-tool");
    } finally {
      await ctx.app.close();
    }
  });
});
