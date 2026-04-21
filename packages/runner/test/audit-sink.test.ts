import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import {
  AuditSink,
  AuditChain,
  parseAuditSinkFailureModeEnv,
  assertAuditSinkEnvListenerSafe,
  AuditSinkOnPublicListener,
  type AuditRecord
} from "../src/audit/index.js";
import {
  permissionsDecisionsPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T15:00:00.000Z");

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ready(): ReadinessProbe {
  return { check: () => null };
}

function sampleRecord(i: number): AuditRecord {
  return {
    id: `aud_test${i.toString().padStart(12, "0")}`,
    timestamp: FROZEN_NOW.toISOString(),
    session_id: "ses_sinkfixture000000a",
    subject_id: "none",
    tool: "fs__write_file",
    args_digest: `sha256:${i.toString().padStart(64, "0")}`,
    capability: "WorkspaceWrite",
    control: "Prompt",
    handler: "Interactive",
    decision: "AutoAllow",
    reason: "test",
    signer_key_id: "",
    prev_hash: "GENESIS",
    this_hash: `hash${i.toString().padStart(60, "0")}`
  };
}

describe("AuditSink §10.5.1 state machine", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir("soa-sink-state-");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("healthy → no events emitted; recordAuditRow is a no-op (no buffer writes)", async () => {
    const sink = new AuditSink({ sessionDir: dir, clock: () => FROZEN_NOW });
    expect(sink.currentState()).toBe("healthy");
    expect(sink.snapshotEvents()).toEqual([]);
    await sink.recordAuditRow(sampleRecord(1));
    // No pending dir created.
    expect(existsSync(join(dir, "audit", "pending"))).toBe(false);
  });

  it("L-28 F-13: fresh boot with initialState=degraded-buffering emits exactly one AuditSinkDegraded event", () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering",
      initialReason: "env-test-hook"
    });
    expect(sink.currentState()).toBe("degraded-buffering");
    const events = sink.snapshotEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("AuditSinkDegraded");
    expect(events[0]?.transition_at).toBe(FROZEN_NOW.toISOString());
    expect(events[0]?.event_id).toMatch(/^evt_[A-Za-z0-9_-]{8,}$/);
    const detail = events[0]?.detail as Record<string, unknown>;
    expect(detail["first_failed_at"]).toBe(FROZEN_NOW.toISOString());
    expect(detail["buffered_records"]).toBe(0);
  });

  it("L-28 F-13: fresh boot with initialState=unreachable-halt emits exactly one AuditSinkUnreachable event", () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "unreachable-halt",
      initialReason: "env-test-hook"
    });
    expect(sink.currentState()).toBe("unreachable-halt");
    const events = sink.snapshotEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("AuditSinkUnreachable");
    const detail = events[0]?.detail as Record<string, unknown>;
    expect(detail["unreachable_since"]).toBe(FROZEN_NOW.toISOString());
  });

  it("degraded-buffering: recordAuditRow writes fsync-backed files to <sessionDir>/audit/pending/", async () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
    const r1 = sampleRecord(1);
    const r2 = sampleRecord(2);
    await sink.recordAuditRow(r1);
    await sink.recordAuditRow(r2);
    const pendingDir = join(dir, "audit", "pending");
    expect(existsSync(pendingDir)).toBe(true);
    const files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
    expect(files).toContain(`${r1.this_hash}.json`);
    expect(files).toContain(`${r2.this_hash}.json`);
    expect(sink.bufferedCount()).toBe(2);
    // No .tmp leftovers.
    expect(readdirSync(pendingDir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("unreachable-halt: shouldRefuseMutating returns true for Mutating and Destructive, false for ReadOnly/Egress", () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "unreachable-halt"
    });
    expect(sink.shouldRefuseMutating("Mutating")).toBe(true);
    expect(sink.shouldRefuseMutating("Destructive")).toBe(true);
    expect(sink.shouldRefuseMutating("ReadOnly")).toBe(false);
    expect(sink.shouldRefuseMutating("Egress")).toBe(false);
  });

  it("readinessReason: returns audit-sink-unreachable in halt, null otherwise", () => {
    const healthy = new AuditSink({ sessionDir: dir, clock: () => FROZEN_NOW });
    expect(healthy.readinessReason()).toBeNull();

    const degraded = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
    expect(degraded.readinessReason()).toBeNull();

    const halted = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "unreachable-halt"
    });
    expect(halted.readinessReason()).toBe("audit-sink-unreachable");
  });

  it("recovery path: flushAndRecover drains buffer, emits AuditSinkRecovered, transitions to healthy", async () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
    await sink.recordAuditRow(sampleRecord(1));
    await sink.recordAuditRow(sampleRecord(2));
    expect(sink.bufferedCount()).toBe(2);

    const shipped: AuditRecord[] = [];
    const event = await sink.flushAndRecover(async (r) => {
      shipped.push(r);
    });

    expect(shipped).toHaveLength(2); // drained in order
    expect(shipped[0]?.id).toBe("aud_test000000000001");
    expect(shipped[1]?.id).toBe("aud_test000000000002");
    expect(sink.currentState()).toBe("healthy");
    expect(sink.bufferedCount()).toBe(0);
    expect(event?.type).toBe("AuditSinkRecovered");
    const detail = event?.detail as Record<string, unknown>;
    expect(detail["flushed_records"]).toBe(2);
    // Pending files cleared.
    const pendingDir = join(dir, "audit", "pending");
    const leftover = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    expect(leftover).toEqual([]);
  });

  it("transitionTo is idempotent on same-state: no duplicate event emitted", () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
    const before = sink.snapshotEvents().length;
    const again = sink.transitionTo("degraded-buffering");
    expect(again).toBeNull();
    expect(sink.snapshotEvents()).toHaveLength(before);
  });

  it("env-hook parser: accepts the three valid values; rejects junk; null when unset", () => {
    expect(parseAuditSinkFailureModeEnv(undefined)).toBeNull();
    expect(parseAuditSinkFailureModeEnv("")).toBeNull();
    expect(parseAuditSinkFailureModeEnv("healthy")).toBe("healthy");
    expect(parseAuditSinkFailureModeEnv("degraded-buffering")).toBe("degraded-buffering");
    expect(parseAuditSinkFailureModeEnv("unreachable-halt")).toBe("unreachable-halt");
    expect(() => parseAuditSinkFailureModeEnv("bogus")).toThrow(/invalid value/);
  });

  it("production guard: env set + non-loopback host → AuditSinkOnPublicListener; loopback allowed", () => {
    expect(() => assertAuditSinkEnvListenerSafe({ envValue: undefined, host: "1.2.3.4" })).not.toThrow();
    expect(() => assertAuditSinkEnvListenerSafe({ envValue: "degraded-buffering", host: "127.0.0.1" })).not.toThrow();
    expect(() => assertAuditSinkEnvListenerSafe({ envValue: "degraded-buffering", host: "::1" })).not.toThrow();
    expect(() => assertAuditSinkEnvListenerSafe({ envValue: "degraded-buffering", host: "localhost" })).not.toThrow();
    expect(() =>
      assertAuditSinkEnvListenerSafe({ envValue: "degraded-buffering", host: "10.0.0.5" })
    ).toThrow(AuditSinkOnPublicListener);
    expect(() =>
      assertAuditSinkEnvListenerSafe({ envValue: "degraded-buffering", host: "runner.example.com" })
    ).toThrow(AuditSinkOnPublicListener);
    // 0.0.0.0 is non-loopback per the bootstrap-bearer guard's convention.
    expect(() =>
      assertAuditSinkEnvListenerSafe({ envValue: "unreachable-halt", host: "0.0.0.0" })
    ).toThrow(AuditSinkOnPublicListener);
  });
});

describe("AuditSink + POST /permissions/decisions integration", () => {
  let dir: string;
  const SESSION = "ses_sinkintegration00aaa";
  const BEARER = "sink-test-bearer";

  function makeRoute(sink: AuditSink) {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
      { name: "fs__write_file", risk_class: "Mutating", default_control: "AutoAllow" },
      { name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }
    ]);
    const app = fastify();
    return { app, store, chain, registry };
  }

  beforeEach(() => {
    dir = tmpDir("soa-sink-route-");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unreachable-halt: Mutating tool invocation → 403 PermissionDenied reason=audit-sink-unreachable; ReadOnly permitted", async () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "unreachable-halt"
    });
    const { app, chain, registry, store } = makeRoute(sink);
    await app.register(permissionsDecisionsPlugin, {
      registry,
      sessionStore: store,
      chain,
      readiness: ready(),
      clock: () => FROZEN_NOW,
      activeCapability: "WorkspaceWrite",
      sink,
      runnerVersion: "1.0"
    });

    const denied = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        tool: "fs__write_file",
        session_id: SESSION,
        args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    });
    expect(denied.statusCode).toBe(403);
    const body = JSON.parse(denied.body) as { error: string; reason: string };
    expect(body.error).toBe("PermissionDenied");
    expect(body.reason).toBe("audit-sink-unreachable");

    const allowed = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        tool: "fs__read_file",
        session_id: SESSION,
        args_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    });
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });

  it("degraded-buffering: /audit/pending/ gets a file per decision record; 201 still returned", async () => {
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      initialState: "degraded-buffering"
    });
    const { app, chain, registry, store } = makeRoute(sink);
    await app.register(permissionsDecisionsPlugin, {
      registry,
      sessionStore: store,
      chain,
      readiness: ready(),
      clock: () => FROZEN_NOW,
      activeCapability: "WorkspaceWrite",
      sink,
      runnerVersion: "1.0"
    });

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        tool: "fs__read_file",
        session_id: SESSION,
        args_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    });
    expect(res.statusCode).toBe(201);

    const pendingDir = join(dir, "audit", "pending");
    expect(existsSync(pendingDir)).toBe(true);
    const files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(sink.bufferedCount()).toBe(1);

    await app.close();
  });
});
