import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  AuditChain,
  auditRecordsPlugin,
  parseAuditSinkModeEnv,
  assertAuditSinkModeListenerSafe,
  AuditSinkModeOnPublicListener
} from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";

// Finding BC (§10.5.5 WORM sink) + Finding BI (§10.5.6 retention_class).

const FROZEN_NOW = new Date("2026-04-22T12:00:00.000Z");
const BOOT_SESSION_ID = "ses_runnerBootLifetime";
const ADMIN_BEARER = "bc-admin-bearer";
const SESSION_ID = "ses_bcFixture00000000001";
const SESSION_BEARER = "bc-session-bearer";

describe("Finding BC (a) — parseAuditSinkModeEnv + production guard", () => {
  it("undefined env → null (no mode)", () => {
    expect(parseAuditSinkModeEnv(undefined)).toBeNull();
  });
  it("empty / whitespace → null", () => {
    expect(parseAuditSinkModeEnv("")).toBeNull();
    expect(parseAuditSinkModeEnv("   ")).toBeNull();
  });
  it("worm-in-memory → canonical mode", () => {
    expect(parseAuditSinkModeEnv("worm-in-memory")).toBe("worm-in-memory");
  });
  it("unknown value → null (safe default)", () => {
    expect(parseAuditSinkModeEnv("s3-object-lock")).toBeNull();
  });
  it("mode null on any host → safe (no throw)", () => {
    expect(() => assertAuditSinkModeListenerSafe({ mode: null, host: "0.0.0.0" })).not.toThrow();
  });
  it("mode worm-in-memory on loopback → safe", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(() =>
        assertAuditSinkModeListenerSafe({ mode: "worm-in-memory", host })
      ).not.toThrow();
    }
  });
  it("mode worm-in-memory on non-loopback → AuditSinkModeOnPublicListener", () => {
    expect(() =>
      assertAuditSinkModeListenerSafe({ mode: "worm-in-memory", host: "0.0.0.0" })
    ).toThrow(AuditSinkModeOnPublicListener);
  });
});

describe("Finding BC (b) — AuditChain sink_timestamp stamping", () => {
  it("no sinkMode → record has no sink_timestamp", () => {
    const chain = new AuditChain(() => FROZEN_NOW);
    const r = chain.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "none",
      decision: "AutoAllow",
      reason: "test"
    });
    expect(r["sink_timestamp"]).toBeUndefined();
    expect(chain.isWormSink()).toBe(false);
  });

  it("worm-in-memory sinkMode → record gets sink_timestamp equal to timestamp", () => {
    const chain = new AuditChain(() => FROZEN_NOW, { sinkMode: "worm-in-memory" });
    const r = chain.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "none",
      decision: "AutoAllow",
      reason: "test"
    });
    expect(r["sink_timestamp"]).toBe(FROZEN_NOW.toISOString());
    expect(r["timestamp"]).toBe(FROZEN_NOW.toISOString());
    expect(chain.isWormSink()).toBe(true);
  });

  it("sink_timestamp participates in hash chain (different sink_timestamp → different this_hash)", () => {
    const t1 = new Date("2026-04-22T12:00:00.000Z");
    const t2 = new Date("2026-04-22T12:00:01.000Z");
    let now = t1;
    const chain1 = new AuditChain(() => now, { sinkMode: "worm-in-memory" });
    const r1 = chain1.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "none",
      decision: "AutoAllow",
      reason: "test"
    });
    now = t2;
    const chain2 = new AuditChain(() => now, { sinkMode: "worm-in-memory" });
    const r2 = chain2.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "none",
      decision: "AutoAllow",
      reason: "test"
    });
    expect(r1["this_hash"]).not.toBe(r2["this_hash"]);
  });

  it("explicit inbound sink_timestamp is preserved (replay scenario)", () => {
    const chain = new AuditChain(() => FROZEN_NOW, { sinkMode: "worm-in-memory" });
    const replayTs = "2026-04-22T11:00:00.000Z";
    const r = chain.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "none",
      decision: "AutoAllow",
      reason: "test",
      sink_timestamp: replayTs
    });
    expect(r["sink_timestamp"]).toBe(replayTs);
  });
});

// ---------------------------------------------------------------------------
// §10.5.5 PUT/DELETE 405 ImmutableAuditSink + system-log emission

async function newApp(sinkMode: "worm-in-memory" | null) {
  const chain = sinkMode
    ? new AuditChain(() => FROZEN_NOW, { sinkMode })
    : new AuditChain(() => FROZEN_NOW);
  const store = new InMemorySessionStore();
  store.register(SESSION_ID, SESSION_BEARER, {
    activeMode: "WorkspaceWrite",
    canDecide: true
  });
  const systemLog = new SystemLogBuffer({ clock: () => FROZEN_NOW });
  const app = fastify();
  await app.register(auditRecordsPlugin, {
    chain,
    sessionStore: store,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    systemLog,
    bootSessionId: BOOT_SESSION_ID
  });
  return { app, chain, store, systemLog };
}

describe("Finding BC (c) — PUT/DELETE /audit/records/:id → 405 ImmutableAuditSink", () => {
  it("PUT /audit/records/:id → 405 {error:ImmutableAuditSink, reason:worm-sink-forbids-mutation}", async () => {
    const ctx = await newApp("worm-in-memory");
    try {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/audit/records/aud_deadbeef",
        headers: { authorization: `Bearer ${ADMIN_BEARER}`, "content-type": "application/json" },
        payload: { decision: "AutoAllow" }
      });
      expect(res.statusCode).toBe(405);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("ImmutableAuditSink");
      expect(body.reason).toBe("worm-sink-forbids-mutation");
    } finally {
      await ctx.app.close();
    }
  });

  it("DELETE /audit/records/:id → 405 ImmutableAuditSink", async () => {
    const ctx = await newApp("worm-in-memory");
    try {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/audit/records/aud_any",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(res.statusCode).toBe(405);
      const body = JSON.parse(res.body) as { error: string; reason: string };
      expect(body.error).toBe("ImmutableAuditSink");
      expect(body.reason).toBe("worm-sink-forbids-mutation");
    } finally {
      await ctx.app.close();
    }
  });

  it("405 is accompanied by /logs/system/recent Audit/error/ImmutableAuditSink record", async () => {
    const ctx = await newApp("worm-in-memory");
    try {
      await ctx.app.inject({
        method: "PUT",
        url: "/audit/records/aud_xxx",
        headers: { authorization: `Bearer ${ADMIN_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      const snap = ctx.systemLog.snapshot(BOOT_SESSION_ID);
      expect(snap.length).toBe(1);
      const rec = snap[0]!;
      expect(rec.category).toBe("Audit");
      expect(rec.level).toBe("error");
      expect(rec.code).toBe("ImmutableAuditSink");
      expect(rec.data?.["method"]).toBe("PUT");
      expect(rec.data?.["record_id"]).toBe("aud_xxx");
      expect(rec.data?.["sink_mode"]).toBe("worm-in-memory");
    } finally {
      await ctx.app.close();
    }
  });

  it("405 fires even when not in WORM mode (audit mutation is never legitimate)", async () => {
    const ctx = await newApp(null);
    try {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/audit/records/aud_x",
        headers: { authorization: `Bearer ${ADMIN_BEARER}`, "content-type": "application/json" },
        payload: {}
      });
      expect(res.statusCode).toBe(405);
      const snap = ctx.systemLog.snapshot(BOOT_SESSION_ID);
      expect(snap[0]?.data?.["sink_mode"]).toBe("non-worm");
    } finally {
      await ctx.app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding BI — retention_class derivation at audit append
// BI is driven from the decisions-route at append-time. Here we verify the
// chain doesn't reject a record carrying retention_class, and that the field
// participates in the hash chain.

describe("Finding BI — retention_class propagation through AuditChain", () => {
  it("retention_class stays on the appended record", () => {
    const chain = new AuditChain(() => FROZEN_NOW);
    const r = chain.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "u_x",
      tool: "fs_read",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "DangerFullAccess",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "test",
      signer_key_id: "",
      retention_class: "dfa-365d"
    });
    expect(r["retention_class"]).toBe("dfa-365d");
  });

  it("retention_class participates in hash chain (different class → different hash)", () => {
    const chain1 = new AuditChain(() => FROZEN_NOW);
    const r1 = chain1.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "u_x",
      tool: "fs_read",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "ReadOnly",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "t",
      signer_key_id: "",
      retention_class: "standard-90d"
    });
    const chain2 = new AuditChain(() => FROZEN_NOW);
    const r2 = chain2.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "u_x",
      tool: "fs_read",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "ReadOnly",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "t",
      signer_key_id: "",
      retention_class: "dfa-365d"
    });
    expect(r1["this_hash"]).not.toBe(r2["this_hash"]);
  });
});
