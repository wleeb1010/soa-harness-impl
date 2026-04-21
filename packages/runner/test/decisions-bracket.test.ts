import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import {
  sessionStatePlugin,
  SessionPersister,
  type PersistedSideEffect
} from "../src/session/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { MarkerEmitter } from "../src/markers/index.js";

// §12.2 L-31 tests: POST /permissions/decisions now runs the bracket-
// persist protocol around every call — pending side_effect persisted,
// markers fired, audit row committed, phase transitioned.

const FROZEN_NOW = new Date("2026-04-21T21:00:00.000Z");
const SESSION = "ses_bracketfixture000001";
const BEARER = "bracket-test-bearer";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-bracket-"));
}

function makeMarkers(): { lines: string[]; emitter: MarkerEmitter } {
  const lines: string[] = [];
  const emitter = new MarkerEmitter({
    enabled: true,
    write: (line) => lines.push(line)
  });
  return { lines, emitter };
}

async function buildRoute(opts: {
  sessionDir: string;
  store: InMemorySessionStore;
  chain: AuditChain;
  markers: MarkerEmitter;
}) {
  // Share the markers emitter with the persister so DIR_FSYNC_DONE +
  // PENDING/COMMITTED_WRITE_DONE lines make it into the captured buffer.
  const persister = new SessionPersister({ sessionDir: opts.sessionDir, markers: opts.markers });
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
    { name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }
  ]);
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore: opts.store,
    chain: opts.chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    persister,
    markers: opts.markers,
    toolPoolHash: "sha256:bracket-test-pool-aa01",
    cardVersion: "1.0.0"
  });
  await app.register(sessionStatePlugin, {
    persister,
    sessionStore: opts.store,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0"
  });
  return { app, persister, registry };
}

describe("POST /permissions/decisions — §12.2 L-31 bracket-persist", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("happy path fires all five markers in documented §12.2 order", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { lines, emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.decision).toBe("AutoAllow");
      expect(typeof body.idempotency_key).toBe("string");

      // §12.2 marker-map boundary order per L-31:
      //   PENDING_WRITE_DONE → DIR_FSYNC_DONE → TOOL_INVOKE_START →
      //   TOOL_INVOKE_DONE → AUDIT_APPEND_DONE → COMMITTED_WRITE_DONE → DIR_FSYNC_DONE
      const marker = (line: string) => line.split(" ")[0];
      expect(lines.map(marker)).toEqual([
        "SOA_MARK_PENDING_WRITE_DONE",
        "SOA_MARK_DIR_FSYNC_DONE",
        "SOA_MARK_TOOL_INVOKE_START",
        "SOA_MARK_AUDIT_APPEND_DONE",
        "SOA_MARK_TOOL_INVOKE_DONE",
        "SOA_MARK_COMMITTED_WRITE_DONE",
        "SOA_MARK_DIR_FSYNC_DONE"
      ]);
    } finally {
      await ctx.app.close();
    }
  });

  it("side_effect populates all six required response-schema fields after commit", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      });
      const persisted = await ctx.persister.readSession(SESSION);
      const se = (persisted.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0]!;
      expect(se.tool).toBe("fs__read_file");
      expect(typeof se.idempotency_key).toBe("string");
      expect(se.phase).toBe("committed");
      expect(se.args_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(se.first_attempted_at).toBe(FROZEN_NOW.toISOString());
      expect(se.last_phase_transition_at).toBe(FROZEN_NOW.toISOString());
      expect(se.result_digest).toMatch(/^sha256:/);
    } finally {
      await ctx.app.close();
    }
  });

  it("GET /sessions/:id/state sees the side_effect after a decision", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      });
      const state = await ctx.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(state.statusCode, `status=${state.statusCode} body=${state.body}`).toBe(200);
      const body = JSON.parse(state.body) as {
        workflow: { side_effects: Array<{ tool: string; phase: string }> };
      };
      expect(body.workflow.side_effects).toHaveLength(1);
      expect(body.workflow.side_effects[0]?.tool).toBe("fs__read_file");
      expect(body.workflow.side_effects[0]?.phase).toBe("committed");
    } finally {
      await ctx.app.close();
    }
  });

  it("idempotency: re-submit with same idempotency_key returns cached decision + NO second audit row", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      const key = "client-idk-abc-0001";
      const first = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "idempotency-key": key
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        }
      });
      expect(first.statusCode).toBe(201);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.idempotency_key).toBe(key);
      expect(firstBody.replayed).toBeUndefined();
      const chainLenAfterFirst = chain.snapshot().length;
      expect(chainLenAfterFirst).toBe(1);

      const second = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "idempotency-key": key
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        }
      });
      expect(second.statusCode).toBe(201);
      const secondBody = JSON.parse(second.body);
      expect(secondBody.replayed).toBe(true);
      expect(secondBody.audit_record_id).toBe(firstBody.audit_record_id);
      expect(secondBody.audit_this_hash).toBe(firstBody.audit_this_hash);
      expect(secondBody.decision).toBe(firstBody.decision);

      // No second audit row appended.
      expect(chain.snapshot().length).toBe(chainLenAfterFirst);
    } finally {
      await ctx.app.close();
    }
  });

  it("different idempotency_key → new side_effect + new audit row (not a cache hit)", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "idempotency-key": "key-one"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        }
      });
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          "idempotency-key": "key-two"
        },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        }
      });
      expect(chain.snapshot().length).toBe(2);
      const persisted = await ctx.persister.readSession(SESSION);
      const ses = (persisted.workflow as { side_effects: PersistedSideEffect[] }).side_effects;
      expect(ses).toHaveLength(2);
      expect(ses[0]?.idempotency_key).toBe("key-one");
      expect(ses[1]?.idempotency_key).toBe("key-two");
      expect(ses[0]?.phase).toBe("committed");
      expect(ses[1]?.phase).toBe("committed");
    } finally {
      await ctx.app.close();
    }
  });

  it("request without idempotency_key still mints one + returns it in the response", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
          // no idempotency_key
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // UUIDv4 RFC 4122 shape: 8-4-4-4-12 hex chars, version nibble "4".
      expect(body.idempotency_key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      await ctx.app.close();
    }
  });

  it("crash-test markers carry session_id + side_effect index in PENDING + COMMITTED lines", async () => {
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { lines, emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        }
      });
      const pending = lines.find((l) => l.startsWith("SOA_MARK_PENDING_WRITE_DONE"));
      const committed = lines.find((l) => l.startsWith("SOA_MARK_COMMITTED_WRITE_DONE"));
      expect(pending).toBe(`SOA_MARK_PENDING_WRITE_DONE session_id=${SESSION} side_effect=0\n`);
      expect(committed).toBe(`SOA_MARK_COMMITTED_WRITE_DONE session_id=${SESSION} side_effect=0\n`);
    } finally {
      await ctx.app.close();
    }
  });

  it("session file is created on first decision when it didn't exist (demo-session fallback)", async () => {
    // RUNNER_DEMO_SESSION registers in memory without writing the file.
    // The bracket path MUST synthesize a Planning-state PersistedSession
    // and write it atomically before appending the first side_effect.
    const store = new InMemorySessionStore();
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite", canDecide: true });
    const { emitter } = makeMarkers();
    const chain = new AuditChain(() => FROZEN_NOW, { markers: emitter });
    const ctx = await buildRoute({ sessionDir: dir, store, chain, markers: emitter });
    try {
      const { existsSync } = await import("node:fs");
      expect(existsSync(ctx.persister.pathFor(SESSION))).toBe(false);
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
      expect(existsSync(ctx.persister.pathFor(SESSION))).toBe(true);
      const persisted = await ctx.persister.readSession(SESSION);
      expect((persisted.workflow as { task_id: string }).task_id).toBe(`bootstrap-${SESSION}`);
      expect((persisted.workflow as { status: string }).status).toBe("Planning");
    } finally {
      await ctx.app.close();
    }
  });
});
