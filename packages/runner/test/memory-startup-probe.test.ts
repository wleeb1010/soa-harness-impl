import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify, type FastifyInstance } from "fastify";
import {
  MemoryMcpClient,
  MemoryReadinessProbe,
  runStartupMemoryProbe
} from "../src/memory/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";

// Finding S / SV-MEM-03 — §8.3 line 581 startup probe semantics.
//
// Contract:
//   - Success (any attempt): probe.markReady(); /ready check() returns null.
//   - Persistent failure: probe.markUnavailable(); /ready check() returns
//     "memory-mcp-unavailable" forever. No background recovery — a
//     fresh Runner process is required.
//   - System Event Log receives per-attempt records (memory-probe-retry
//     on failures, memory-ready on success, memory-unavailable-startup
//     on final failure).
//   - Before probe runs at all: state=pending; check() returns
//     "memory-mcp-unavailable" (paired with bootstrap-pending from the
//     BootOrchestrator so /ready reports SOME reason throughout boot).

const FROZEN_NOW = new Date("2026-04-22T08:00:00.000Z");

async function buildMock(mode: "ok" | "always-fail"): Promise<{
  app: FastifyInstance;
  endpoint: string;
  callCount: () => number;
}> {
  const app = fastify();
  let calls = 0;
  app.post("/search_memories", async (_req, reply) => {
    calls++;
    if (mode === "always-fail") return reply.code(504).send({ error: "mock-timeout" });
    return reply.send({ notes: [] });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
  return { app, endpoint: `http://127.0.0.1:${addr.port}`, callCount: () => calls };
}

describe("MemoryReadinessProbe — §8.3 startup-probe state machine", () => {
  it("constructs in `pending` — check() returns memory-mcp-unavailable", () => {
    const probe = new MemoryReadinessProbe();
    expect(probe.getState()).toBe("pending");
    expect(probe.check()).toBe("memory-mcp-unavailable");
  });

  it("markReady: check() returns null", () => {
    const probe = new MemoryReadinessProbe();
    probe.markReady();
    expect(probe.getState()).toBe("ready");
    expect(probe.check()).toBeNull();
  });

  it("markUnavailable: check() stays memory-mcp-unavailable; lastError carries detail", () => {
    const probe = new MemoryReadinessProbe();
    probe.markUnavailable("connection refused");
    expect(probe.getState()).toBe("unavailable");
    expect(probe.check()).toBe("memory-mcp-unavailable");
    expect(probe.getLastError()).toBe("connection refused");
  });
});

describe("runStartupMemoryProbe — §8.3 driver", () => {
  let mock: Awaited<ReturnType<typeof buildMock>> | null = null;

  beforeEach(() => {
    mock = null;
  });

  afterEach(async () => {
    if (mock?.app) await mock.app.close();
  });

  it("mock returns 200 on attempt 1 → ready=true; probe.markReady fired; System Event Log memory-ready record", async () => {
    mock = await buildMock("ok");
    const client = new MemoryMcpClient({ endpoint: mock.endpoint, timeoutMs: 500 });
    const probe = new MemoryReadinessProbe();
    const systemLog = new SystemLogBuffer({ clock: () => FROZEN_NOW });

    const result = await runStartupMemoryProbe({
      client,
      probe,
      systemLog,
      log: () => {},
      errorLog: () => {}
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(1);
    expect(probe.getState()).toBe("ready");
    expect(probe.check()).toBeNull();

    const logs = systemLog.snapshot("ses_runner_boot_____");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.category).toBe("MemoryLoad");
    expect(logs[0]?.code).toBe("memory-ready");
    expect(logs[0]?.level).toBe("info");
  });

  it("always-fail: exhausts retries → ready=false; probe marks unavailable; final log record is memory-unavailable-startup level=error", async () => {
    mock = await buildMock("always-fail");
    const client = new MemoryMcpClient({ endpoint: mock.endpoint, timeoutMs: 500 });
    const probe = new MemoryReadinessProbe();
    const systemLog = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    const errorLines: string[] = [];

    const result = await runStartupMemoryProbe({
      client,
      probe,
      systemLog,
      maxAttempts: 3,
      backoffMs: 0, // tests don't need real sleep
      log: () => {},
      errorLog: (m) => errorLines.push(m),
      sleep: async () => {} // fast-path: no real setTimeout
    });

    expect(result.ready).toBe(false);
    expect(result.attempts).toBe(3);
    expect(probe.getState()).toBe("unavailable");
    expect(probe.check()).toBe("memory-mcp-unavailable");
    expect(probe.getLastError()).toContain("MemoryUnavailableStartup");

    // 3 retry warn records + 1 final error record = 4 entries.
    const logs = systemLog.snapshot("ses_runner_boot_____");
    expect(logs).toHaveLength(4);
    const retries = logs.filter((l) => l.code === "memory-probe-retry");
    expect(retries).toHaveLength(3);
    for (const r of retries) {
      expect(r.category).toBe("MemoryDegraded");
      expect(r.level).toBe("warn");
    }
    const final = logs.find((l) => l.code === "memory-unavailable-startup");
    expect(final).toBeDefined();
    expect(final?.category).toBe("Error");
    expect(final?.level).toBe("error");

    // Operator-facing FATAL line hit stderr.
    expect(errorLines.join("\n")).toContain("MemoryUnavailableStartup");
    expect(errorLines.join("\n")).toContain("/ready will remain 503");
  });

  it("mock 200 after 1 miss: ready=true on attempt 2; logs carry a retry warn then a memory-ready info", async () => {
    const app = fastify();
    let calls = 0;
    app.post("/search_memories", async (_req, reply) => {
      calls++;
      if (calls === 1) return reply.code(504).send({ error: "mock-timeout" });
      return reply.send({ notes: [] });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
    const endpoint = `http://127.0.0.1:${addr.port}`;

    const client = new MemoryMcpClient({ endpoint, timeoutMs: 500 });
    const probe = new MemoryReadinessProbe();
    const systemLog = new SystemLogBuffer({ clock: () => FROZEN_NOW });

    try {
      const result = await runStartupMemoryProbe({
        client,
        probe,
        systemLog,
        maxAttempts: 3,
        backoffMs: 0,
        log: () => {},
        errorLog: () => {},
        sleep: async () => {}
      });
      expect(result.ready).toBe(true);
      expect(result.attempts).toBe(2);
      expect(probe.getState()).toBe("ready");
      const logs = systemLog.snapshot("ses_runner_boot_____");
      expect(logs.map((l) => l.code)).toEqual(["memory-probe-retry", "memory-ready"]);
    } finally {
      await app.close();
    }
  });
});
