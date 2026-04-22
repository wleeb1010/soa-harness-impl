import { describe, it, expect } from "vitest";
import { fastify, type FastifyInstance } from "fastify";
import { MemoryMcpClient, ConsolidationScheduler } from "../src/memory/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";
import { BOOT_SESSION_ID } from "../src/permission/boot-session.js";

// Finding U / SV-MEM-05 — §8.4 consolidation scheduler.
//   - 24 h elapsed-time trigger (default)
//   - ≥100 notes/session trigger (default; fires immediately on the
//     crossing write_memory)
//   - On success: ContextLoad/consolidation-ran/info System Event Log record
//   - On failure: Error/consolidation-failed/error record + lastRunAt
//                 NOT advanced so the next tick retries
//   - Idempotent start/stop; timers are unref'd so they don't keep
//     the process alive past shutdown

const SESSION_A = "ses_consolidation_fix_a";
const SESSION_B = "ses_consolidation_fix_b";

async function buildMock(mode: "ok" | "error"): Promise<{
  app: FastifyInstance;
  endpoint: string;
  calls: () => number;
}> {
  const app = fastify();
  let calls = 0;
  app.post("/consolidate_memories", async (_req, reply) => {
    calls++;
    if (mode === "error") return reply.send({ error: "mock-error" });
    return reply.send({ consolidated_count: 42, pending_count: 0 });
  });
  app.post("/search_memories", async (_req, reply) => reply.send({ notes: [] }));
  app.post("/write_memory", async (_req, reply) => reply.send({ note_id: "mem_x" }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
  return { app, endpoint: `http://127.0.0.1:${addr.port}`, calls: () => calls };
}

describe("ConsolidationScheduler — Finding U / SV-MEM-05", () => {
  it("runNow: fires consolidate_memories immediately; logs ContextLoad/consolidation-ran", async () => {
    const mock = await buildMock("ok");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      const systemLog = new SystemLogBuffer({ clock: () => new Date("2026-04-22T11:00:00.000Z") });
      const sched = new ConsolidationScheduler({
        client,
        systemLog,
        clock: () => new Date("2026-04-22T11:00:00.000Z"),
        log: () => {}
      });
      const outcome = await sched.runNow();
      expect(outcome.trigger).toBe("manual");
      expect(outcome.consolidated_count).toBe(42);
      expect(outcome.pending_count).toBe(0);
      expect(mock.calls()).toBe(1);

      const logs = systemLog.snapshot(BOOT_SESSION_ID);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.category).toBe("ContextLoad");
      expect(logs[0]?.code).toBe("consolidation-ran");
      expect(logs[0]?.level).toBe("info");
    } finally {
      await mock.app.close();
    }
  });

  it("note-count trigger: crossing the 100-note threshold fires consolidation and resets that session's counter to 0", async () => {
    const mock = await buildMock("ok");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      const sched = new ConsolidationScheduler({
        client,
        clock: () => new Date("2026-04-22T11:00:00.000Z"),
        noteCountThreshold: 3, // lower bar for tests
        log: () => {}
      });
      // 2 writes — below threshold; no consolidation.
      expect(await sched.recordNoteWritten(SESSION_A)).toBeNull();
      expect(await sched.recordNoteWritten(SESSION_A)).toBeNull();
      expect(mock.calls()).toBe(0);
      expect(sched.snapshotCounts().get(SESSION_A)).toBe(2);

      // 3rd write crosses the threshold → immediate consolidation.
      const outcome = await sched.recordNoteWritten(SESSION_A);
      expect(outcome).not.toBeNull();
      expect(outcome?.trigger).toBe("note-count");
      expect(mock.calls()).toBe(1);
      // Counter reset on the crossing session, not on other sessions.
      expect(sched.snapshotCounts().get(SESSION_A)).toBe(0);
    } finally {
      await mock.app.close();
    }
  });

  it("multi-session: each session tracks its own counter independently", async () => {
    const mock = await buildMock("ok");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      const sched = new ConsolidationScheduler({
        client,
        clock: () => new Date("2026-04-22T11:00:00.000Z"),
        noteCountThreshold: 3,
        log: () => {}
      });
      await sched.recordNoteWritten(SESSION_A);
      await sched.recordNoteWritten(SESSION_A);
      await sched.recordNoteWritten(SESSION_B);
      expect(sched.snapshotCounts().get(SESSION_A)).toBe(2);
      expect(sched.snapshotCounts().get(SESSION_B)).toBe(1);
      expect(mock.calls()).toBe(0);
    } finally {
      await mock.app.close();
    }
  });

  it("elapsed-time trigger: 24 h tick fires consolidation when maybeFireElapsed runs after intervalMs", async () => {
    const mock = await buildMock("ok");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      let now = new Date("2026-04-22T11:00:00.000Z");
      const fakeInterval = {
        handler: null as (() => void) | null,
        unref() {}
      };
      const sched = new ConsolidationScheduler({
        client,
        clock: () => now,
        intervalMs: 100, // ms for test
        tickIntervalMs: 50,
        log: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setInterval: ((h: () => void) => {
          fakeInterval.handler = h;
          return fakeInterval as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: (() => {
          fakeInterval.handler = null;
        }) as unknown as typeof clearInterval
      });
      sched.start();
      // First tick: clock has NOT advanced past intervalMs → no fire.
      fakeInterval.handler?.();
      await new Promise((r) => setTimeout(r, 10));
      expect(mock.calls()).toBe(0);
      // Advance wall clock past intervalMs.
      now = new Date(now.getTime() + 200);
      fakeInterval.handler?.();
      await new Promise((r) => setTimeout(r, 20));
      expect(mock.calls()).toBe(1);
      sched.stop();
    } finally {
      await mock.app.close();
    }
  });

  it("failure path: consolidate_memories returns error → Error/consolidation-failed record + lastRunAt NOT advanced", async () => {
    const mock = await buildMock("error");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      const systemLog = new SystemLogBuffer({ clock: () => new Date("2026-04-22T12:00:00.000Z") });
      const sched = new ConsolidationScheduler({
        client,
        systemLog,
        clock: () => new Date("2026-04-22T12:00:00.000Z"),
        log: () => {}
      });
      const firstLastRun = sched.lastRunIso();
      await sched.runNow();
      const afterLastRun = sched.lastRunIso();
      // lastRunAt stays fixed so the next tick retries — §8.4
      // resilience: don't let a flaky MCP push the next run 24h out.
      expect(afterLastRun).toBe(firstLastRun);

      const logs = systemLog.snapshot(BOOT_SESSION_ID);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.category).toBe("Error");
      expect(logs[0]?.code).toBe("consolidation-failed");
      expect(logs[0]?.level).toBe("error");
    } finally {
      await mock.app.close();
    }
  });

  it("start/stop are idempotent; stop clears the interval", async () => {
    const mock = await buildMock("ok");
    try {
      const client = new MemoryMcpClient({ endpoint: mock.endpoint });
      let cleared = 0;
      const sched = new ConsolidationScheduler({
        client,
        clock: () => new Date(),
        log: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setInterval: (() => ({ unref() {} } as unknown as ReturnType<typeof setInterval>)) as unknown as typeof setInterval,
        clearInterval: (() => {
          cleared++;
        }) as unknown as typeof clearInterval
      });
      sched.start();
      sched.start(); // second start no-op
      sched.stop();
      sched.stop(); // second stop no-op
      expect(cleared).toBe(1);
    } finally {
      await mock.app.close();
    }
  });
});
