import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fastify } from "fastify";
import { jcsBytes } from "@soa-harness/core";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";

// Finding L (SV-HOOK-05) + SV-HOOK-07 — §14.1 PreToolUseOutcome emission
// by POST /permissions/decisions after the PreToolUse hook runs.
//
// Shape the validator polls on /events/recent:
//   tool_call_id:         synthesized per-request (tc_<12hex>)
//   tool_name:             echoed from the request body
//   outcome:               "allow" | "deny" | "replace_args"
//   reason?:               hook stdout.reason, "hook-forced-prompt" on Prompt,
//                          or the outcome.reason on Deny fallback
//   args_digest_before:    original request args_digest
//   args_digest_after?:    present iff outcome=replace_args
//                          = "sha256:" + sha256(JCS(replace_args))
//
// Ordering invariant (SV-HOOK-07):
//   PermissionDecision → PreToolUseOutcome   (success paths)
//   PreToolUseOutcome only                    (Deny short-circuit)

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "hooks");
const FROZEN_NOW = new Date("2026-04-22T01:00:00.000Z");
const SESSION = "ses_pretoolusefixture00001";
const BEARER = "pretooluse-bearer";

async function newApp(preCmd: readonly string[]) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
    { name: "fs__write_file", risk_class: "Mutating", default_control: "AutoAllow" }
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
    hookConfig: { preToolUseCommand: preCmd }
  });
  return { app, store, chain, emitter };
}

describe("§14.1 PreToolUseOutcome — hook-outcome stream emission (SV-HOOK-05 / SV-HOOK-07)", () => {
  it("replace_args: emits outcome=replace_args with args_digest_before + args_digest_after; downstream args_digest is the substituted one", async () => {
    const ctx = await newApp([process.execPath, join(FIXTURES, "replace-args.mjs")]);
    try {
      const originalDigest = "sha256:aaaa111111111111111111111111111111111111111111111111111111111111";
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: originalDigest
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string; audit_record_id: string };
      expect(body.decision).toBe("AutoAllow");

      // The replace-args.mjs fixture returns { path: "/tmp/safe-path", mode: "rw" }.
      const expectedAfter =
        "sha256:" +
        createHash("sha256")
          .update(jcsBytes({ path: "/tmp/safe-path", mode: "rw" }))
          .digest("hex");

      // Audit row's args_digest is the POST-substitution digest, not the
      // originally-supplied one — the whole point of replace_args wiring.
      const audit = ctx.chain.snapshot();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.args_digest).toBe(expectedAfter);

      // Stream: PermissionDecision → PreToolUseOutcome, monotonic.
      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision", "PreToolUseOutcome"]);
      expect(events[0]!.sequence).toBe(0);
      expect(events[1]!.sequence).toBe(1);

      const pre = events[1]!;
      expect(pre.payload).toMatchObject({
        tool_name: "fs__read_file",
        outcome: "replace_args",
        reason: "hook-substituted-args",
        args_digest_before: originalDigest,
        args_digest_after: expectedAfter
      });
      expect(pre.payload.tool_call_id as string).toMatch(/^tc_[0-9a-f]{12}$/);
    } finally {
      await ctx.app.close();
    }
  });

  it("allow (no replace_args): emits outcome=allow with args_digest_before only; no args_digest_after", async () => {
    const ctx = await newApp([process.execPath, join(FIXTURES, "allow.mjs")]);
    try {
      const originalDigest = "sha256:bbbb222222222222222222222222222222222222222222222222222222222222";
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: originalDigest
        }
      });
      expect(res.statusCode).toBe(201);

      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision", "PreToolUseOutcome"]);
      const pre = events[1]!;
      expect(pre.payload).toMatchObject({
        tool_name: "fs__read_file",
        outcome: "allow",
        args_digest_before: originalDigest
      });
      expect("args_digest_after" in (pre.payload as Record<string, unknown>)).toBe(false);

      // Audit row's args_digest is UNCHANGED (no substitution).
      expect(ctx.chain.snapshot()[0]!.args_digest).toBe(originalDigest);
    } finally {
      await ctx.app.close();
    }
  });

  it("deny (exit 1): emits outcome=deny BEFORE the 403 return; no PermissionDecision event", async () => {
    const ctx = await newApp([process.execPath, join(FIXTURES, "deny.mjs")]);
    try {
      const originalDigest = "sha256:cccc333333333333333333333333333333333333333333333333333333333333";
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: originalDigest
        }
      });
      expect(res.statusCode).toBe(403);

      // PermissionDecision does NOT fire on the deny short-circuit (no
      // audit row is appended); only PreToolUseOutcome.
      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual(["PreToolUseOutcome"]);
      const pre = events[0]!;
      expect(pre.payload).toMatchObject({
        tool_name: "fs__read_file",
        outcome: "deny",
        args_digest_before: originalDigest
      });
      // No audit row, no args_digest_after.
      expect(ctx.chain.snapshot()).toHaveLength(0);
      expect("args_digest_after" in (pre.payload as Record<string, unknown>)).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });

  it("prompt (exit 3): emits outcome=allow with reason=hook-forced-prompt; final decision is Prompt", async () => {
    const ctx = await newApp([process.execPath, join(FIXTURES, "prompt.mjs")]);
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
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string; reason: string };
      expect(body.decision).toBe("Prompt");

      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision", "PreToolUseOutcome"]);
      const pre = events[1]!;
      expect(pre.payload).toMatchObject({
        outcome: "allow",
        reason: "hook-forced-prompt"
      });
    } finally {
      await ctx.app.close();
    }
  });

  it("no emitter wired: decision path still works (foundation backwards-compat)", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
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
      // No emitter.
      hookConfig: { preToolUseCommand: [process.execPath, join(FIXTURES, "replace-args.mjs")] }
    });
    try {
      const res = await app.inject({
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
      // Even without an emitter, replace_args still substitutes the
      // downstream digest — the emission gate is on the event, not on
      // the args substitution.
      const expectedAfter =
        "sha256:" +
        createHash("sha256")
          .update(jcsBytes({ path: "/tmp/safe-path", mode: "rw" }))
          .digest("hex");
      expect(chain.snapshot()[0]!.args_digest).toBe(expectedAfter);
    } finally {
      await app.close();
    }
  });
});
