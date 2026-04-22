import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import {
  SessionPersister,
  scanAndResumeInProgressSessions,
  type PersistedSession,
  type PersistedSideEffect,
  type ResumeContext
} from "../src/session/index.js";
import {
  StreamEventEmitter,
  eventsRecentPlugin,
  STREAM_EVENT_TYPES
} from "../src/stream/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";

// Finding AE / SV-STR-10 — CrashEvent emission from boot-scan's
// resume-with-open-bracket path + §14.5.5 /events/recent admin:read
// cross-session surface.

const FROZEN_NOW = new Date("2026-04-22T18:00:00.000Z");
const CARD_VERSION = "1.0";
const TOOL_POOL_HASH = "sha256:aebootscanpool00000000000000000000000000000000000000000000000001";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "soa-ae-"));
}

function makeSession(
  id: string,
  status: string,
  sideEffects: PersistedSideEffect[] = []
): PersistedSession {
  return {
    session_id: id,
    format_version: "1.0",
    activeMode: "WorkspaceWrite",
    messages: [],
    workflow: {
      task_id: `task-${id}`,
      status,
      side_effects: sideEffects,
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: TOOL_POOL_HASH,
    card_version: CARD_VERSION
  } as PersistedSession;
}

function makeCtx(): ResumeContext {
  return {
    currentCardVersion: CARD_VERSION,
    currentToolPoolHash: TOOL_POOL_HASH,
    toolCompensation: (name) => ({ canCompensate: name === "compensable_tool" }),
    replayPending: async () => null,
    compensate: async () => undefined,
    cardActiveMode: "WorkspaceWrite",
    clock: () => FROZEN_NOW
  };
}

describe("Finding AE (a) — boot-scan CrashEvent emission", () => {
  let dir: string;
  let persister: SessionPersister;

  beforeEach(() => {
    dir = tmp();
    persister = new SessionPersister({ sessionDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resume with pending side_effect → CrashEvent emitted with required fields", async () => {
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const s = makeSession("ses_aePending000000000001", "Executing", [
      { tool: "fs_write", idempotency_key: "idem_1", phase: "pending" }
    ]);
    await persister.writeSession(s);

    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW,
      emitter
    });

    const evts = emitter.snapshot(s.session_id);
    expect(evts.length).toBe(1);
    const ev = evts[0]!;
    expect(ev.type).toBe("CrashEvent");
    expect(STREAM_EVENT_TYPES.includes(ev.type)).toBe(true);
    expect(ev.payload["reason"]).toBe("resume-with-open-bracket");
    expect(ev.payload["workflow_state_id"]).toBe("task-ses_aePending000000000001");
    expect(ev.payload["last_committed_event_id"]).toBe("none");
    expect(typeof ev.payload["stack_hint"]).toBe("string");
    expect((ev.payload["stack_hint"] as string)).toMatch(/replayed=1/);
  });

  it("resume with inflight side_effect → CrashEvent; compensation-gap present in stack_hint", async () => {
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const s = makeSession("ses_aeInflight00000000001", "Executing", [
      { tool: "fs_rm", idempotency_key: "idem_2", phase: "inflight" }
    ]);
    await persister.writeSession(s);

    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW,
      emitter
    });

    const evts = emitter.snapshot(s.session_id);
    expect(evts.length).toBe(1);
    expect(evts[0]!.type).toBe("CrashEvent");
    expect((evts[0]!.payload["stack_hint"] as string)).toMatch(/compensation-gap=1/);
  });

  it("last_committed_event_id reads the final committed side_effect's idempotency_key", async () => {
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const s = makeSession("ses_aeCommitted0000000001", "Executing", [
      { tool: "fs_read", idempotency_key: "idem_committed_1", phase: "committed" },
      { tool: "fs_read", idempotency_key: "idem_committed_2", phase: "committed" },
      { tool: "fs_write", idempotency_key: "idem_pending_1", phase: "pending" }
    ]);
    await persister.writeSession(s);

    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW,
      emitter
    });

    const evts = emitter.snapshot(s.session_id);
    expect(evts[0]!.payload["last_committed_event_id"]).toBe("idem_committed_2");
  });

  it("resume with only committed + compensated (no open bracket) → NO CrashEvent emitted", async () => {
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const s = makeSession("ses_aeNoOpenBracket000001", "Executing", [
      { tool: "fs_read", idempotency_key: "idem_c", phase: "committed" },
      { tool: "fs_rm", idempotency_key: "idem_done", phase: "compensated" }
    ]);
    await persister.writeSession(s);

    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW,
      emitter
    });

    expect(emitter.hasSession(s.session_id)).toBe(false);
  });

  it("terminal status (skipped-terminal) → NO CrashEvent emitted", async () => {
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const s = makeSession("ses_aeTerminal0000000001", "Succeeded", [
      // Even a pending row on a terminal session MUST NOT synthesize a crash
      // — resumeSession isn't invoked on terminal statuses.
      { tool: "fs_write", idempotency_key: "idem_stale", phase: "pending" }
    ]);
    await persister.writeSession(s);

    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW,
      emitter
    });

    expect(emitter.hasSession(s.session_id)).toBe(false);
  });

  it("emitter omitted → boot-scan still runs; no CrashEvent recorded", async () => {
    const s = makeSession("ses_aeNoEmitter000000001", "Executing", [
      { tool: "fs_write", idempotency_key: "idem_n", phase: "pending" }
    ]);
    await persister.writeSession(s);

    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: () => undefined,
      clock: () => FROZEN_NOW
    });

    expect(outcomes[0]!.action).toBe("resumed");
  });
});

// --------------------------------------------------------------------------
// §14.5.5 /events/recent admin:read semantics

const ADMIN_BEARER = "ae-admin-bearer";
const SESSION_ID = "ses_aeAdminFixture0000001";
const SESSION_BEARER = "ae-session-bearer";

async function newApp(overrides: { adminRpm?: number; sessionRpm?: number } = {}) {
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION_ID, SESSION_BEARER, {
    activeMode: "WorkspaceWrite",
    canDecide: true
  });
  const app = fastify();
  await app.register(eventsRecentPlugin, {
    emitter,
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    bootstrapBearer: ADMIN_BEARER,
    ...(overrides.adminRpm !== undefined ? { adminRequestsPerMinute: overrides.adminRpm } : {}),
    ...(overrides.sessionRpm !== undefined ? { requestsPerMinute: overrides.sessionRpm } : {})
  });
  return { app, emitter, sessionStore };
}

describe("Finding AE (b) — /events/recent admin:read cross-session + type filter", () => {
  it("admin bearer WITHOUT session_id returns events across all sessions", async () => {
    const ctx = await newApp();
    try {
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000001",
        type: "SessionStart",
        payload: { bound_activeMode: "WorkspaceWrite" }
      });
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000002",
        type: "CrashEvent",
        payload: {
          reason: "resume-with-open-bracket",
          workflow_state_id: "task-x",
          last_committed_event_id: "none"
        }
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { events: Array<{ session_id: string; type: string }> };
      const sessions = new Set(body.events.map((e) => e.session_id));
      expect(sessions.size).toBe(2);
      const types = new Set(body.events.map((e) => e.type));
      expect(types.has("SessionStart")).toBe(true);
      expect(types.has("CrashEvent")).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("admin bearer + type=CrashEvent narrows to CrashEvents only", async () => {
    const ctx = await newApp();
    try {
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000001",
        type: "SessionStart",
        payload: {}
      });
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000002",
        type: "CrashEvent",
        payload: {
          reason: "resume-with-open-bracket",
          workflow_state_id: "task-y",
          last_committed_event_id: "idem_z"
        }
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/events/recent?type=CrashEvent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { events: Array<{ type: string }> };
      expect(body.events.length).toBe(1);
      expect(body.events[0]!.type).toBe("CrashEvent");
    } finally {
      await ctx.app.close();
    }
  });

  it("admin bearer + session_id scopes to that session only", async () => {
    const ctx = await newApp();
    try {
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000001",
        type: "SessionStart",
        payload: {}
      });
      ctx.emitter.emit({
        session_id: "ses_aeAdminFixture0000002",
        type: "CrashEvent",
        payload: {
          reason: "resume-with-open-bracket",
          workflow_state_id: "task-y",
          last_committed_event_id: "none"
        }
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/events/recent?session_id=ses_aeAdminFixture0000001`,
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { events: Array<{ session_id: string }> };
      expect(body.events.length).toBe(1);
      expect(body.events[0]!.session_id).toBe("ses_aeAdminFixture0000001");
    } finally {
      await ctx.app.close();
    }
  });

  it("type=<unknown> → 400 unknown-stream-event-type", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/events/recent?type=NotARealType",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("unknown-stream-event-type");
    } finally {
      await ctx.app.close();
    }
  });

  it("session-scope bearer still requires session_id (unchanged pre-L-47 behavior)", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${SESSION_BEARER}` }
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("malformed-session-id");
    } finally {
      await ctx.app.close();
    }
  });

  it("session-scope bearer + correct session_id → 200 (additive admin change didn't break sessions:read)", async () => {
    const ctx = await newApp();
    try {
      ctx.emitter.emit({
        session_id: SESSION_ID,
        type: "SessionStart",
        payload: {}
      });
      const res = await ctx.app.inject({
        method: "GET",
        url: `/events/recent?session_id=${SESSION_ID}`,
        headers: { authorization: `Bearer ${SESSION_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { events: unknown[] };
      expect(body.events.length).toBe(1);
    } finally {
      await ctx.app.close();
    }
  });

  it("missing bearer → 401 missing-or-invalid-bearer", async () => {
    const ctx = await newApp();
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/events/recent"
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await ctx.app.close();
    }
  });

  it("admin rate limit defaults to 60 rpm (lower than session 120) — 61st call → 429", async () => {
    const ctx = await newApp({ adminRpm: 2 });
    try {
      const ok1 = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      const ok2 = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      const tooMany = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      expect(ok1.statusCode).toBe(200);
      expect(ok2.statusCode).toBe(200);
      expect(tooMany.statusCode).toBe(429);
    } finally {
      await ctx.app.close();
    }
  });

  it("cross-session merge is deterministic across repeated calls (byte-identity ex generated_at)", async () => {
    const ctx = await newApp();
    try {
      for (let i = 0; i < 3; i++) {
        ctx.emitter.emit({
          session_id: "ses_aeAdminFixture0000001",
          type: "SessionStart",
          payload: { n: i }
        });
        ctx.emitter.emit({
          session_id: "ses_aeAdminFixture0000002",
          type: "CrashEvent",
          payload: {
            reason: "resume-with-open-bracket",
            workflow_state_id: `t-${i}`,
            last_committed_event_id: "none"
          }
        });
      }
      const r1 = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      const r2 = await ctx.app.inject({
        method: "GET",
        url: "/events/recent",
        headers: { authorization: `Bearer ${ADMIN_BEARER}` }
      });
      const b1 = JSON.parse(r1.body) as Record<string, unknown>;
      const b2 = JSON.parse(r2.body) as Record<string, unknown>;
      delete b1["generated_at"];
      delete b2["generated_at"];
      expect(b1).toEqual(b2);
    } finally {
      await ctx.app.close();
    }
  });
});
