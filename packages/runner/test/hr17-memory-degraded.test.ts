import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify, type FastifyInstance } from "fastify";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { SessionPersister } from "../src/session/index.js";
import { StreamEventEmitter, eventsRecentPlugin } from "../src/stream/index.js";
import {
  InMemoryMemoryStateStore,
  MemoryMcpClient,
  MemoryDegradationTracker
} from "../src/memory/index.js";
import { BudgetTracker } from "../src/budget/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";

const FROZEN_NOW = new Date("2026-04-22T10:00:00.000Z");
const BOOTSTRAP_BEARER = "hr17-bootstrap-bearer";

async function buildMemoryMock(mode: "timeout-always" | "ok"): Promise<{
  app: FastifyInstance;
  endpoint: string;
}> {
  const app = fastify();
  app.post("/search_memories", async (_req, reply) => {
    if (mode === "timeout-always") return reply.code(504).send({ error: "mock-timeout" });
    return reply.send({
      notes: [
        {
          note_id: "mem_hr17_ok_0001",
          summary: "happy path note",
          data_class: "public",
          composite_score: 0.5
        }
      ]
    });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
  return { app, endpoint: `http://127.0.0.1:${addr.port}` };
}

async function buildRunner(memoryEndpoint: string, sessionDir: string) {
  const app = fastify();
  const sessionStore = new InMemorySessionStore();
  const persister = new SessionPersister({ sessionDir });
  const memoryStore = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const budgetTracker = new BudgetTracker();
  const memoryClient = new MemoryMcpClient({ endpoint: memoryEndpoint, timeoutMs: 300 });
  const memoryDegradation = new MemoryDegradationTracker(3);
  const systemLog = new SystemLogBuffer({ clock: () => FROZEN_NOW });

  await app.register(sessionsBootstrapPlugin, {
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    cardActiveMode: "DangerFullAccess",
    bootstrapBearer: BOOTSTRAP_BEARER,
    runnerVersion: "1.0",
    persister,
    toolPoolHash: "sha256:hr17test00000000000000000000000000000000000000000000000000000001",
    cardVersion: "1.0.0",
    emitter,
    agentName: "hr17-test-agent",
    memoryStore,
    budgetTracker,
    memoryClient,
    memoryDegradation,
    systemLog
  });

  await app.register(eventsRecentPlugin, {
    emitter,
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0"
  });

  return { app, sessionStore, emitter, memoryDegradation, systemLog };
}

describe("HR-17 — Memory MCP timeouts → SessionEnd{stop_reason:MemoryDegraded}", () => {
  let dir: string;
  let mock: Awaited<ReturnType<typeof buildMemoryMock>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soa-hr17-"));
  });
  afterEach(async () => {
    if (mock?.app) await mock.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Finding T two-tier gating — first 2 timeouts log only; 3rd crosses threshold and emits SessionEnd{MemoryDegraded}", async () => {
    mock = await buildMemoryMock("timeout-always");
    const runner = await buildRunner(mock.endpoint, dir);
    try {
      const sessionIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await runner.app.inject({
          method: "POST",
          url: "/sessions",
          headers: {
            authorization: `Bearer ${BOOTSTRAP_BEARER}`,
            "content-type": "application/json"
          },
          payload: {
            requested_activeMode: "ReadOnly",
            user_sub: `hr17-subject-${i}`
          }
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { session_id: string; session_bearer: string };
        sessionIds.push(body.session_id);
      }

      // §8.3 two-tier semantics (L-38 Finding T):
      //   - Sessions 1 + 2 (failure count 1/3, 2/3): SessionStart ONLY.
      //     Memory degradation logged to the System Event Log but session
      //     continues with a stale (empty) slice.
      //   - Session 3 (failure count crosses 3/3 threshold): SessionStart
      //     + SessionEnd{stop_reason:"MemoryDegraded"} per §8.3.1.
      const first = runner.emitter.snapshot(sessionIds[0]!);
      expect(first.map((e) => e.type)).toEqual(["SessionStart"]);
      const second = runner.emitter.snapshot(sessionIds[1]!);
      expect(second.map((e) => e.type)).toEqual(["SessionStart"]);
      const third = runner.emitter.snapshot(sessionIds[2]!);
      expect(third.map((e) => e.type)).toEqual(["SessionStart", "SessionEnd"]);
      expect((third[1]?.payload as { stop_reason?: string }).stop_reason).toBe(
        "MemoryDegraded"
      );

      // Counter reached the threshold.
      expect(runner.memoryDegradation.currentCount()).toBe(3);
      expect(runner.memoryDegradation.isDegraded()).toBe(true);

      // System Event Log accumulated one MemoryDegraded record PER session
      // (3 total), each with level=warn + code=memory-timeout. Category
      // filter confirms §14.5.4 closed-enum membership.
      for (const sid of sessionIds) {
        const logs = runner.systemLog.snapshot(sid, new Set(["MemoryDegraded"] as const));
        expect(logs).toHaveLength(1);
        expect(logs[0]?.level).toBe("warn");
        expect(logs[0]?.code).toBe("memory-timeout");
      }
    } finally {
      await runner.app.close();
    }
  });

  it("happy-path mock → no SessionEnd; memory state shows the loaded note", async () => {
    mock = await buildMemoryMock("ok");
    const runner = await buildRunner(mock.endpoint, dir);
    try {
      const res = await runner.app.inject({
        method: "POST",
        url: "/sessions",
        headers: {
          authorization: `Bearer ${BOOTSTRAP_BEARER}`,
          "content-type": "application/json"
        },
        payload: { requested_activeMode: "ReadOnly", user_sub: "hr17-happy-subject" }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { session_id: string };
      const events = runner.emitter.snapshot(body.session_id);
      // SessionStart fires but SessionEnd does NOT (happy path).
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("SessionStart");
      expect(runner.memoryDegradation.currentCount()).toBe(0);
    } finally {
      await runner.app.close();
    }
  });

  it("mixed: fail, fail, succeed — degradation counter resets on success", async () => {
    // Server flips mid-test by swapping handlers. Emulate by using a
    // counter-driven mock.
    const app = fastify();
    let callCount = 0;
    app.post("/search_memories", async (_req, reply) => {
      callCount++;
      if (callCount <= 2) return reply.code(504).send({ error: "mock-timeout" });
      return reply.send({
        notes: [
          {
            note_id: "mem_mixed_0001",
            summary: "ok",
            data_class: "public",
            composite_score: 0.5
          }
        ]
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
    const endpoint = `http://127.0.0.1:${addr.port}`;
    const runner = await buildRunner(endpoint, dir);
    try {
      for (let i = 0; i < 3; i++) {
        await runner.app.inject({
          method: "POST",
          url: "/sessions",
          headers: {
            authorization: `Bearer ${BOOTSTRAP_BEARER}`,
            "content-type": "application/json"
          },
          payload: {
            requested_activeMode: "ReadOnly",
            user_sub: `mixed-subject-${i}`
          }
        });
      }
      // 2 failures followed by 1 success → counter is back at 0.
      expect(runner.memoryDegradation.currentCount()).toBe(0);
      expect(runner.memoryDegradation.isDegraded()).toBe(false);
    } finally {
      await runner.app.close();
      await app.close();
    }
  });
});
