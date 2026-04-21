import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import {
  sessionStatePlugin,
  SessionPersister,
  type PersistedSession
} from "../src/session/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessProbe, ReadinessReason } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T12:00:00.000Z");
const RUNNER_VERSION = "1.0";
const SESSION = "ses_statefixture000001aa";
const BEARER = "state-test-bearer-xyz";

function buildReadiness(reason: ReadinessReason | null): ReadinessProbe {
  return { check: () => reason };
}

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-state-"));
}

function fullSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    session_id: SESSION,
    format_version: "1.0",
    activeMode: "WorkspaceWrite",
    created_at: "2026-04-21T11:00:00.000Z",
    last_significant_event_at: "2026-04-21T11:30:00.000Z",
    messages: [],
    workflow: {
      task_id: "task-42",
      status: "Executing",
      side_effects: [
        {
          tool: "fs__write_file",
          idempotency_key: "idk-0001",
          phase: "pending",
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
          first_attempted_at: "2026-04-21T11:05:00.000Z",
          last_phase_transition_at: "2026-04-21T11:05:00.000Z"
        },
        {
          tool: "fs__write_file",
          idempotency_key: "idk-0002",
          phase: "committed",
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
          result_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000022",
          first_attempted_at: "2026-04-21T11:10:00.000Z",
          last_phase_transition_at: "2026-04-21T11:11:00.000Z"
        },
        {
          tool: "fs__delete_file",
          idempotency_key: "idk-0003",
          phase: "compensated",
          args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000003",
          first_attempted_at: "2026-04-21T11:20:00.000Z",
          last_phase_transition_at: "2026-04-21T11:25:00.000Z"
        }
      ],
      checkpoint: { last_step: 3 }
    },
    counters: { tool_calls: 3, retries: 0 },
    tool_pool_hash: "sha256:aaaa000000000000000000000000000000000000000000000000000000000000",
    card_version: "1.0",
    ...overrides
  } as PersistedSession;
}

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
  sessionDir?: string;
  preRegister?: boolean;
} = {}) {
  const dir = overrides.sessionDir ?? tmpSessionDir();
  const persister = new SessionPersister({ sessionDir: dir });
  const store = new InMemorySessionStore();
  if (overrides.preRegister !== false) {
    store.register(SESSION, BEARER, { activeMode: "WorkspaceWrite" });
  }
  const app = fastify();
  await app.register(sessionStatePlugin, {
    persister,
    sessionStore: store,
    readiness: overrides.readiness ?? buildReadiness(null),
    clock: () => FROZEN_NOW,
    runnerVersion: RUNNER_VERSION,
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, persister, store, dir };
}

describe("GET /sessions/:session_id/state — §12.5.1", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(() => {
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("happy path: 200 + schema-valid body; pending/committed/compensated side_effects all carry all six required fields", async () => {
    await ctx.persister.writeSession(fullSession());
    const res = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = JSON.parse(res.body) as Record<string, unknown>;
    const validator = schemaRegistry["session-state-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);

    expect(body["session_id"]).toBe(SESSION);
    expect(body["format_version"]).toBe("1.0");
    expect(body["activeMode"]).toBe("WorkspaceWrite");
    expect(body["runner_version"]).toBe(RUNNER_VERSION);
    expect(body["generated_at"]).toBe(FROZEN_NOW.toISOString());

    const workflow = body["workflow"] as { side_effects: Array<Record<string, unknown>> };
    expect(workflow.side_effects).toHaveLength(3);
    for (const se of workflow.side_effects) {
      expect(typeof se["tool"]).toBe("string");
      expect(typeof se["idempotency_key"]).toBe("string");
      expect(typeof se["phase"]).toBe("string");
      expect(typeof se["args_digest"]).toBe("string");
      expect(typeof se["first_attempted_at"]).toBe("string");
      expect(typeof se["last_phase_transition_at"]).toBe("string");
    }
    const phases = workflow.side_effects.map((se) => se["phase"]);
    expect(phases).toEqual(["pending", "committed", "compensated"]);
  });

  it("byte-identity: two reads ≤ 1s apart are byte-equal when generated_at is excluded", async () => {
    await ctx.persister.writeSession(fullSession());
    const a = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const aBody = JSON.parse(a.body) as Record<string, unknown>;
    const bBody = JSON.parse(b.body) as Record<string, unknown>;
    delete aBody["generated_at"];
    delete bBody["generated_at"];
    expect(JSON.stringify(aBody)).toBe(JSON.stringify(bBody));
  });

  it("404: unknown session_id (no in-memory record)", async () => {
    const unknown = "ses_definitelydoesnotexistxx";
    const res = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${unknown}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("unknown-session");
  });

  it("403: bearer mismatched for the claimed session_id", async () => {
    await ctx.persister.writeSession(fullSession());
    const res = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer not-the-right-bearer` }
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("session-bearer-mismatch");
  });

  it("429: rate-limit kicks in at the configured per-minute ceiling with Retry-After", async () => {
    const small = await newApp({ requestsPerMinute: 2 });
    try {
      await small.persister.writeSession(fullSession());
      const a = await small.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const c = await small.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(c.statusCode).toBe(429);
      expect(c.headers["retry-after"]).toBeDefined();
      const body = JSON.parse(c.body) as { error: string };
      expect(body.error).toBe("rate-limit-exceeded");
    } finally {
      rmSync(small.dir, { recursive: true, force: true });
    }
  });

  it("503: pre-boot readiness → not-ready with §5.4 closed-enum reason", async () => {
    const pre = await newApp({ readiness: buildReadiness("bootstrap-pending") });
    try {
      const res = await pre.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { status: string; reason: string };
      expect(body.status).toBe("not-ready");
      expect(body.reason).toBe("bootstrap-pending");
    } finally {
      rmSync(pre.dir, { recursive: true, force: true });
    }
  });

  it("401: missing or non-Bearer Authorization header", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`
    });
    expect(res.statusCode).toBe(401);
  });

  it("400: session_id does not match ^ses_[A-Za-z0-9]{16,}$", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/sessions/bogus-id/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("malformed-session-id");
  });

  it("L-29 lazy-hydrate: on-disk session with no in-memory record → 200 after first call registers", async () => {
    // Fresh app with a session file on disk but NO in-memory registration.
    // First request hydrates (registering bearer + session), second request
    // with the same bearer passes normal validate().
    const fresh = await newApp({ preRegister: false });
    try {
      await fresh.persister.writeSession(fullSession());
      const first = await fresh.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(first.statusCode, `status=${first.statusCode} body=${first.body}`).toBe(200);
      const second = await fresh.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(second.statusCode).toBe(200);
    } finally {
      await fresh.app.close();
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });

  it("L-29 lazy-hydrate: first-bearer-wins — subsequent different bearer gets 403", async () => {
    const fresh = await newApp({ preRegister: false });
    try {
      await fresh.persister.writeSession(fullSession());
      // First caller (original bearer) hydrates + succeeds.
      const first = await fresh.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(first.statusCode).toBe(200);
      // Second caller with a DIFFERENT bearer is rejected with
      // session-bearer-mismatch — hydrate happens only once; subsequent
      // calls go through the normal sessionStore.validate() gate.
      const second = await fresh.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer a-completely-different-bearer` }
      });
      expect(second.statusCode).toBe(403);
      const body = JSON.parse(second.body) as { error: string };
      expect(body.error).toBe("session-bearer-mismatch");
    } finally {
      await fresh.app.close();
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });

  it("SV-SESS-09: lazy-hydrate with resumeCtx catches CardVersionDrift → 409", async () => {
    const dir = tmpSessionDir();
    const persister = new SessionPersister({ sessionDir: dir });
    const store = new InMemorySessionStore();
    const app = fastify();
    const resumeCtx = {
      currentCardVersion: "1.1.0",
      currentToolPoolHash: "sha256:dontcare",
      toolCompensation: () => ({ canCompensate: false }),
      replayPending: async () => null,
      compensate: async () => undefined,
      cardActiveMode: "WorkspaceWrite" as const,
      clock: () => FROZEN_NOW
    };
    await app.register(sessionStatePlugin, {
      persister,
      sessionStore: store,
      readiness: buildReadiness(null),
      clock: () => FROZEN_NOW,
      runnerVersion: RUNNER_VERSION,
      resumeCtx
    });
    try {
      // Persist a session with card_version 1.0.0. Runtime resumeCtx claims
      // 1.1.0 — resumeSession step 2 fires CardVersionDrift.
      await persister.writeSession(fullSession({ card_version: "1.0.0" }));
      const res = await app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string; expected: string; actual: string };
      expect(body.error).toBe("card-version-drift");
      expect(body.expected).toBe("1.1.0");
      expect(body.actual).toBe("1.0.0");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L-29 lazy-hydrate: no session file on disk → 404 unknown-session (unchanged)", async () => {
    const fresh = await newApp({ preRegister: false });
    try {
      // No session file written — hydrate returns false; handler 404s.
      const res = await fresh.app.inject({
        method: "GET",
        url: `/sessions/${SESSION}/state`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("unknown-session");
    } finally {
      await fresh.app.close();
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });

  it("not-a-side-effect: persister file size stays identical across two reads (no on-disk mutation)", async () => {
    const { statSync } = await import("node:fs");
    await ctx.persister.writeSession(fullSession());
    const finalPath = ctx.persister.pathFor(SESSION);
    const sizeA = statSync(finalPath).size;
    const mtimeA = statSync(finalPath).mtimeMs;
    await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    await ctx.app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/state`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const sizeB = statSync(finalPath).size;
    const mtimeB = statSync(finalPath).mtimeMs;
    expect(sizeB).toBe(sizeA);
    expect(mtimeB).toBe(mtimeA);
  });
});
