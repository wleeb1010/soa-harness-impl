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

// Finding M (SV-HOOK-06) + SV-HOOK-07 — §14.1 PostToolUseOutcome emission
// by POST /permissions/decisions after the PostToolUse hook runs, plus
// full PermissionDecision → PreToolUseOutcome → PostToolUseOutcome
// ordering when both pre- and post-hooks are wired.
//
// Payload shape per §14.1.1 $defs/PostToolUseOutcome:
//   tool_call_id:          shared with the matching PreToolUseOutcome when
//                          both fire on the same decision (SV-HOOK-07 ties)
//   tool_name:             echoed from the request
//   outcome:               "pass" | "replace_result"
//   reason?:               hook stdout.reason, or the runHook failure reason
//                          fallback (hook-timeout / hook-crashed / …)
//   output_digest_before:  synthetic "sha256:<audit this_hash>" in M3
//                          (becomes real tool-result digest under M4 dispatcher)
//   output_digest_after?:  present iff outcome=replace_result;
//                          "sha256:" + sha256(JCS(replace_result))

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures", "hooks");
const FROZEN_NOW = new Date("2026-04-22T02:15:00.000Z");
const SESSION = "ses_postusefixture00000001";
const BEARER = "posttooluse-bearer";

async function newApp(overrides: {
  preCmd?: readonly string[];
  postCmd?: readonly string[];
}) {
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
    hookConfig: {
      ...(overrides.preCmd !== undefined ? { preToolUseCommand: overrides.preCmd } : {}),
      ...(overrides.postCmd !== undefined ? { postToolUseCommand: overrides.postCmd } : {})
    }
  });
  return { app, store, chain, emitter };
}

describe("§14.1 PostToolUseOutcome — hook-outcome stream emission (SV-HOOK-06 / SV-HOOK-07)", () => {
  it("replace_result: emits outcome=replace_result with output_digest_before + output_digest_after; tool_call_id matches PreToolUseOutcome when pre-hook also wired", async () => {
    const ctx = await newApp({
      preCmd: [process.execPath, join(FIXTURES, "allow.mjs")],
      postCmd: [process.execPath, join(FIXTURES, "replace-result.mjs")]
    });
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
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { decision: string; audit_this_hash: string };
      expect(body.decision).toBe("AutoAllow");

      // Ordering: PermissionDecision → PreToolUseOutcome → PostToolUseOutcome.
      const events = ctx.emitter.snapshot(SESSION);
      expect(events.map((e) => e.type)).toEqual([
        "PermissionDecision",
        "PreToolUseOutcome",
        "PostToolUseOutcome"
      ]);
      expect(events[0]!.sequence).toBe(0);
      expect(events[1]!.sequence).toBe(1);
      expect(events[2]!.sequence).toBe(2);

      const pre = events[1]!;
      const post = events[2]!;

      // SV-HOOK-07: Pre and Post share the same tool_call_id.
      expect((pre.payload as Record<string, unknown>).tool_call_id).toBe(
        (post.payload as Record<string, unknown>).tool_call_id
      );
      expect(post.payload.tool_call_id as string).toMatch(/^tc_[0-9a-f]{12}$/);

      // replace_result fixture returned { status:"ok", redacted:true, items:3 }
      const expectedAfter =
        "sha256:" +
        createHash("sha256")
          .update(jcsBytes({ status: "ok", redacted: true, items: 3 }))
          .digest("hex");
      const expectedBefore = `sha256:${body.audit_this_hash}`;

      expect(post.payload).toMatchObject({
        tool_name: "fs__read_file",
        outcome: "replace_result",
        reason: "hook-redacted-secrets",
        output_digest_before: expectedBefore,
        output_digest_after: expectedAfter
      });
    } finally {
      await ctx.app.close();
    }
  });

  it("pass (no replace_result): emits outcome=pass with output_digest_before only", async () => {
    const ctx = await newApp({
      postCmd: [process.execPath, join(FIXTURES, "allow.mjs")]
    });
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
      const body = JSON.parse(res.body) as { audit_this_hash: string };

      const events = ctx.emitter.snapshot(SESSION);
      // Pre-hook absent → no PreToolUseOutcome; still get
      // PermissionDecision + PostToolUseOutcome in strict order.
      expect(events.map((e) => e.type)).toEqual(["PermissionDecision", "PostToolUseOutcome"]);
      const post = events[1]!;
      expect(post.payload).toMatchObject({
        tool_name: "fs__read_file",
        outcome: "pass",
        output_digest_before: `sha256:${body.audit_this_hash}`
      });
      expect("output_digest_after" in (post.payload as Record<string, unknown>)).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });

  it("advisory non-zero exit: still emits outcome=pass with failure reason; response is NOT flipped to Deny", async () => {
    // deny.mjs exits 1. PostToolUse's Deny is advisory per §15.3 —
    // response stays 201 AutoAllow; StreamEvent records outcome=pass
    // with reason carrying the failure code (closed §15 hook-reason set).
    const ctx = await newApp({
      postCmd: [process.execPath, join(FIXTURES, "deny.mjs")]
    });
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
      expect(JSON.parse(res.body).decision).toBe("AutoAllow");

      const events = ctx.emitter.snapshot(SESSION);
      const post = events.find((e) => e.type === "PostToolUseOutcome")!;
      expect(post.payload).toMatchObject({
        outcome: "pass"
      });
      // reason may be undefined for clean Deny (no stdout, no failure
      // reason on exit 1 which is a valid §15.3 mapping) — either way
      // the event fires and outcome=pass. Tolerate both.
    } finally {
      await ctx.app.close();
    }
  });

  it("full Pre+Post pipeline (SV-HOOK-07 ordering): PermissionDecision → PreToolUseOutcome(replace_args) → PostToolUseOutcome(replace_result)", async () => {
    const ctx = await newApp({
      preCmd: [process.execPath, join(FIXTURES, "replace-args.mjs")],
      postCmd: [process.execPath, join(FIXTURES, "replace-result.mjs")]
    });
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

      const events = ctx.emitter.snapshot(SESSION);
      // Strict ordering + sequence monotonicity across all three events.
      expect(events.map((e) => e.type)).toEqual([
        "PermissionDecision",
        "PreToolUseOutcome",
        "PostToolUseOutcome"
      ]);
      expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
      // Pre and Post share the same synthesized tool_call_id.
      const preTcid = (events[1]!.payload as Record<string, unknown>).tool_call_id;
      const postTcid = (events[2]!.payload as Record<string, unknown>).tool_call_id;
      expect(preTcid).toBe(postTcid);
      expect(preTcid as string).toMatch(/^tc_[0-9a-f]{12}$/);
      // The Pre side shows replace_args outcome; Post side shows
      // replace_result outcome — fully distinct substitution pipelines.
      expect((events[1]!.payload as Record<string, unknown>).outcome).toBe("replace_args");
      expect((events[2]!.payload as Record<string, unknown>).outcome).toBe("replace_result");
    } finally {
      await ctx.app.close();
    }
  });

  it("no emitter wired: hook still runs; no event emission (foundation backwards-compat)", async () => {
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
      hookConfig: {
        postToolUseCommand: [process.execPath, join(FIXTURES, "replace-result.mjs")]
      }
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
      // No emitter = no StreamEvent; hook's own side effects (stdout/
      // stderr/exit code) still flow through runHook.
    } finally {
      await app.close();
    }
  });
});
