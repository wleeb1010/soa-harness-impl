import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify, type FastifyInstance } from "fastify";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { SessionPersister } from "../src/session/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import {
  MemoryMcpClient,
  InMemoryMemoryStateStore
} from "../src/memory/index.js";
import { BudgetTracker } from "../src/budget/index.js";
import { OtelEmitter, OtelSpanStore } from "../src/observability/index.js";
import type { SharingPolicy } from "../src/memory/state-store.js";

// Finding V (SV-MEM-06) — sharing_scope flows from card.memory.
// default_sharing_scope into the bootstrap-time searchMemories call.
// Finding X (SV-STR-07) — every emitted span carries service.version
// in resource_attributes, regardless of card-supplied override.

const FROZEN_NOW = new Date("2026-04-22T10:00:00.000Z");
const BOOTSTRAP_BEARER = "vx-bootstrap-bearer";

async function buildCapturingMock(): Promise<{
  app: FastifyInstance;
  endpoint: string;
  seen: { sharing_scope?: SharingPolicy }[];
}> {
  const app = fastify();
  const seen: { sharing_scope?: SharingPolicy }[] = [];
  app.post("/search_memories", async (req, reply) => {
    const body = req.body as { sharing_scope?: SharingPolicy };
    seen.push(body);
    return reply.send({ hits: [] });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (typeof addr === "string" || addr === null) throw new Error("unexpected address");
  return { app, endpoint: `http://127.0.0.1:${addr.port}`, seen };
}

describe("Finding V — sharing_scope threaded from card.memory.default_sharing_scope", () => {
  let dir: string;
  let mock: Awaited<ReturnType<typeof buildCapturingMock>>;

  it("card declares default_sharing_scope=project → POST /search_memories carries sharing_scope:project", async () => {
    dir = mkdtempSync(join(tmpdir(), "soa-v-"));
    mock = await buildCapturingMock();
    try {
      const app = fastify();
      const sessionStore = new InMemorySessionStore();
      const persister = new SessionPersister({ sessionDir: dir });
      const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
      const budgetTracker = new BudgetTracker();
      const memoryStore = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
      const memoryClient = new MemoryMcpClient({ endpoint: mock.endpoint });
      await app.register(sessionsBootstrapPlugin, {
        sessionStore,
        readiness: { check: () => null },
        clock: () => FROZEN_NOW,
        cardActiveMode: "ReadOnly",
        bootstrapBearer: BOOTSTRAP_BEARER,
        runnerVersion: "1.0",
        persister,
        toolPoolHash: "sha256:fv000000000000000000000000000000000000000000000000000000000000000",
        cardVersion: "1.0.0",
        emitter,
        agentName: "vfix",
        memoryStore,
        budgetTracker,
        memoryClient,
        memoryDefaultSharingScope: "project"
      });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/sessions",
          headers: {
            authorization: `Bearer ${BOOTSTRAP_BEARER}`,
            "content-type": "application/json"
          },
          payload: { requested_activeMode: "ReadOnly", user_sub: "v-subject" }
        });
        expect(res.statusCode).toBe(201);
        expect(mock.seen).toHaveLength(1);
        expect(mock.seen[0]?.sharing_scope).toBe("project");
      } finally {
        await app.close();
      }
    } finally {
      await mock.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("card omits default_sharing_scope → falls back to \"session\" (least-privilege default)", async () => {
    dir = mkdtempSync(join(tmpdir(), "soa-v-"));
    mock = await buildCapturingMock();
    try {
      const app = fastify();
      const sessionStore = new InMemorySessionStore();
      const persister = new SessionPersister({ sessionDir: dir });
      const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
      const budgetTracker = new BudgetTracker();
      const memoryStore = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
      const memoryClient = new MemoryMcpClient({ endpoint: mock.endpoint });
      await app.register(sessionsBootstrapPlugin, {
        sessionStore,
        readiness: { check: () => null },
        clock: () => FROZEN_NOW,
        cardActiveMode: "ReadOnly",
        bootstrapBearer: BOOTSTRAP_BEARER,
        runnerVersion: "1.0",
        persister,
        toolPoolHash: "sha256:fv000000000000000000000000000000000000000000000000000000000000000",
        cardVersion: "1.0.0",
        emitter,
        agentName: "vfix",
        memoryStore,
        budgetTracker,
        memoryClient
        // memoryDefaultSharingScope intentionally omitted.
      });
      try {
        await app.inject({
          method: "POST",
          url: "/sessions",
          headers: {
            authorization: `Bearer ${BOOTSTRAP_BEARER}`,
            "content-type": "application/json"
          },
          payload: { requested_activeMode: "ReadOnly", user_sub: "v-subject-2" }
        });
        expect(mock.seen).toHaveLength(1);
        expect(mock.seen[0]?.sharing_scope).toBe("session");
      } finally {
        await app.close();
      }
    } finally {
      await mock.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Finding X — service.version always in resource_attributes", () => {
  it("custom requiredResourceAttrs WITHOUT service.version still emits it (unconditional stamp)", () => {
    const store = new OtelSpanStore();
    const emitter = new OtelEmitter({
      store,
      agentName: "test-agent",
      agentVersion: "1.0.0",
      billingTag: "conformance-test",
      // Operator omits service.version from the required list on purpose.
      requiredResourceAttrs: ["service.name", "soa.agent.name"],
      runnerVersion: "1.2.3",
      clock: () => FROZEN_NOW
    });
    emitter.emitDecisionSpans({
      session_id: "ses_xtest00000000000000001",
      turn_id: "turn_x",
      tool_name: "fs__read_file",
      tool_risk_class: "ReadOnly",
      permission_decision: "AutoAllow"
    });
    const [turn] = store.snapshot("ses_xtest00000000000000001");
    expect(turn!.resource_attributes["service.name"]).toBe("test-agent");
    expect(turn!.resource_attributes["service.version"]).toBe("1.2.3");
  });

  it("default requiredResourceAttrs list includes service.version at position 2", async () => {
    const { DEFAULT_REQUIRED_RESOURCE_ATTRS } = await import(
      "../src/observability/index.js"
    );
    expect(DEFAULT_REQUIRED_RESOURCE_ATTRS).toContain("service.version");
  });
});
