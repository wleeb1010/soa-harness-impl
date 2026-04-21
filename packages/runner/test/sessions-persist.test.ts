import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import { sessionsBootstrapPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { sessionStatePlugin, SessionPersister } from "../src/session/index.js";

// §12.6 persist-before-201 integration tests. Covers the cross-endpoint
// consistency bug the validator surfaced: POST /sessions and
// /sessions/:id/state sharing the same in-memory store AND the same
// on-disk session file.

const FROZEN = new Date("2026-04-21T20:00:00.000Z");
const BOOTSTRAP_BEARER = "op-tool-bootstrap-bearer-persist";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-persist-"));
}

async function buildPipeline(sessionDir: string, sharedStore?: InMemorySessionStore) {
  const app = fastify();
  const store = sharedStore ?? new InMemorySessionStore();
  const persister = new SessionPersister({ sessionDir });
  await app.register(sessionsBootstrapPlugin, {
    sessionStore: store,
    readiness: { check: () => null },
    clock: () => FROZEN,
    cardActiveMode: "DangerFullAccess",
    bootstrapBearer: BOOTSTRAP_BEARER,
    persister,
    toolPoolHash: "sha256:registry-size-8",
    cardVersion: "1.0.0",
    runnerVersion: "1.0"
  });
  await app.register(sessionStatePlugin, {
    persister,
    sessionStore: store,
    readiness: { check: () => null },
    clock: () => FROZEN,
    runnerVersion: "1.0"
  });
  return { app, store, persister };
}

describe("POST /sessions → GET /state round-trip (§12.6 persist-before-201)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("same-process: mint session, immediately read state → 200 with matching session_id", async () => {
    const { app, persister } = await buildPipeline(dir);
    try {
      const create = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify({
          requested_activeMode: "WorkspaceWrite",
          user_sub: "alice"
        })
      });
      expect(create.statusCode).toBe(201);
      const created = JSON.parse(create.body) as { session_id: string; session_bearer: string };
      // §12.6 MUST — file exists on disk by the time 201 returns.
      expect(existsSync(persister.pathFor(created.session_id))).toBe(true);

      const state = await app.inject({
        method: "GET",
        url: `/sessions/${created.session_id}/state`,
        headers: { authorization: `Bearer ${created.session_bearer}` }
      });
      expect(state.statusCode, `status=${state.statusCode} body=${state.body}`).toBe(200);
      const body = JSON.parse(state.body) as {
        session_id: string;
        activeMode: string;
        workflow: { status: string; side_effects: unknown[] };
      };
      expect(body.session_id).toBe(created.session_id);
      expect(body.activeMode).toBe("WorkspaceWrite");
      expect(body.workflow.status).toBe("Planning");
      expect(body.workflow.side_effects).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("lazy-hydrate after restart: kill app, new app with same sessionDir, state read still works", async () => {
    // Phase 1: mint a session with the bootstrap pipeline.
    const first = await buildPipeline(dir);
    const create = await first.app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        requested_activeMode: "ReadOnly",
        user_sub: "bob"
      })
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body) as { session_id: string; session_bearer: string };
    expect(existsSync(first.persister.pathFor(created.session_id))).toBe(true);
    await first.app.close();

    // Phase 2: fresh app instance, DIFFERENT SessionStore (simulates a
    // process restart — in-memory state lost; on-disk state retained).
    const second = await buildPipeline(dir, new InMemorySessionStore());
    try {
      // Session not in the new in-memory store; lazy-hydrate MUST read the
      // on-disk file and register the session with the presented bearer.
      const state = await second.app.inject({
        method: "GET",
        url: `/sessions/${created.session_id}/state`,
        headers: { authorization: `Bearer ${created.session_bearer}` }
      });
      expect(state.statusCode, `status=${state.statusCode} body=${state.body}`).toBe(200);
      const body = JSON.parse(state.body) as { session_id: string; activeMode: string };
      expect(body.session_id).toBe(created.session_id);
      expect(body.activeMode).toBe("ReadOnly");
    } finally {
      await second.app.close();
    }
  });

  it("persist-misconfiguration: persister without toolPoolHash → 500 session-persist-misconfigured (operator config bug)", async () => {
    const app = fastify();
    const store = new InMemorySessionStore();
    const persister = new SessionPersister({ sessionDir: dir });
    await app.register(sessionsBootstrapPlugin, {
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN,
      cardActiveMode: "DangerFullAccess",
      bootstrapBearer: BOOTSTRAP_BEARER,
      persister,
      // toolPoolHash + cardVersion intentionally omitted
      runnerVersion: "1.0"
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("session-persist-misconfigured");
      // The in-memory session was rolled back on misconfiguration.
      expect(store.exists("ses_anythingatall0001")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("backwards-compat: plugin without persister option still returns 201 (in-memory only)", async () => {
    // Regression guard for the existing 13 sessions-bootstrap tests — none
    // of them pass persister. Behavior unchanged when persister is absent.
    const app = fastify();
    const store = new InMemorySessionStore();
    await app.register(sessionsBootstrapPlugin, {
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN,
      cardActiveMode: "DangerFullAccess",
      bootstrapBearer: BOOTSTRAP_BEARER,
      runnerVersion: "1.0"
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: JSON.stringify({ requested_activeMode: "ReadOnly", user_sub: "alice" })
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
