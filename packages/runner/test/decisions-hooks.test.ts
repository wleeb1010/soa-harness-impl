import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";

// §15 hook-pipeline integration with /permissions/decisions (M3-T6).
// Verifies that PreToolUse Deny short-circuits to 403 PermissionDenied
// with reason=hook-deny, and that PreToolUse Prompt forces the final
// decision into Prompt. PostToolUse is advisory and doesn't mutate the
// response body.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "hooks");

const FROZEN_NOW = new Date("2026-04-21T23:50:00.000Z");
const SESSION = "ses_hookintegfixture00001";
const BEARER = "hook-integration-bearer";

async function newApp(
  overrides: {
    preCmd?: readonly string[];
    postCmd?: readonly string[];
  } = {}
) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
    { name: "fs__write_file", risk_class: "Mutating", default_control: "AutoAllow" }
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
    ...(overrides.preCmd || overrides.postCmd
      ? {
          hookConfig: {
            ...(overrides.preCmd !== undefined ? { preToolUseCommand: overrides.preCmd } : {}),
            ...(overrides.postCmd !== undefined ? { postToolUseCommand: overrides.postCmd } : {})
          }
        }
      : {})
  });
  return { app, store, chain };
}

describe("§15 hook pipeline — /permissions/decisions integration", () => {
  it("PreToolUse Deny (exit 1) short-circuits to 403 PermissionDenied reason=hook-deny; no audit row", async () => {
    const ctx = await newApp({ preCmd: [process.execPath, join(FIXTURES, "deny.mjs")] });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        }
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toBe("hook-deny");
      // No audit row — the pre-hook short-circuit happens BEFORE the
      // audit-chain append path.
      expect(ctx.chain.snapshot().length).toBe(0);
    } finally {
      await ctx.app.close();
    }
  });

  it("PreToolUse Allow (exit 0) lets the resolver run; decision is 201 AutoAllow", async () => {
    const ctx = await newApp({ preCmd: [process.execPath, join(FIXTURES, "allow.mjs")] });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");
      expect(ctx.chain.snapshot().length).toBe(1);
    } finally {
      await ctx.app.close();
    }
  });

  it("PreToolUse Prompt (exit 3) forces final decision into Prompt even when resolver would AutoAllow", async () => {
    const ctx = await newApp({ preCmd: [process.execPath, join(FIXTURES, "prompt.mjs")] });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string; reason: string };
      expect(body.decision).toBe("Prompt");
      expect(body.reason).toBe("hook-forced-prompt");
    } finally {
      await ctx.app.close();
    }
  });

  it("PostToolUse is advisory — exit 1 does NOT flip the response to Deny", async () => {
    // Use deny.mjs as the post hook (exits 1). Decision body should still
    // be 201 AutoAllow; the hook's Deny-signal is logged but not reflected
    // in the response per §15.3 PostToolUse semantics (acknowledge/log).
    const ctx = await newApp({ postCmd: [process.execPath, join(FIXTURES, "deny.mjs")] });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444"
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string };
      expect(body.decision).toBe("AutoAllow");
    } finally {
      await ctx.app.close();
    }
  });

  it("no hook config: decisions behave as before (backwards-compat)", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555"
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await ctx.app.close();
    }
  });
});
