import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { memoryStatePlugin, InMemoryMemoryStateStore } from "../src/memory/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessProbe } from "../src/probes/index.js";

const FROZEN_NOW = new Date("2026-04-21T23:45:00.000Z");
const SESSION = "ses_memstatefixture00001";
const BEARER = "mem-state-test-bearer";

async function newApp(overrides: {
  readiness?: ReadinessProbe;
  requestsPerMinute?: number;
  initMemory?: boolean;
} = {}) {
  const app = fastify();
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION, BEARER, { activeMode: "WorkspaceWrite" });
  const memoryStore = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
  if (overrides.initMemory !== false) {
    memoryStore.initFor({ session_id: SESSION });
  }
  await app.register(memoryStatePlugin, {
    memoryStore,
    sessionStore,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined
      ? { requestsPerMinute: overrides.requestsPerMinute }
      : {})
  });
  return { app, sessionStore, memoryStore };
}

describe("GET /memory/state/:session_id — §8.6 (SV-MEM-STATE-01/02)", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeEach(async () => {
    ctx = await newApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("SV-MEM-STATE-01: 200 + schema-valid zero-state body on a fresh session", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode, `status=${res.statusCode} body=${res.body}`).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const validator = schemaRegistry["memory-state-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);
    expect(body["session_id"]).toBe(SESSION);
    expect(body["sharing_policy"]).toBe("session");
    expect(body["in_context_notes"]).toEqual([]);
    expect(body["available_notes_count"]).toBe(0);
    const cons = body["consolidation"] as { last_run_at: string; pending_notes: number };
    expect(cons.last_run_at).toBe(FROZEN_NOW.toISOString());
    expect(cons.pending_notes).toBe(0);
  });

  it("SV-MEM-STATE-02: byte-identity — two reads are byte-equal excluding generated_at", async () => {
    const a = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
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

  it("loaded in_context_notes show up in the response with all required fields + loaded_at", async () => {
    ctx.memoryStore.recordLoad(
      SESSION,
      [
        {
          note_id: "mem_seed_0014",
          summary: "Token budget projection uses p95-over-W algorithm.",
          data_class: "public",
          weight_semantic: 1,
          weight_recency: 0.1,
          weight_graph_strength: 0.6,
          composite_score: 0.675
        }
      ],
      20
    );
    const res = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      in_context_notes: Array<Record<string, unknown>>;
      available_notes_count: number;
    };
    expect(body.in_context_notes).toHaveLength(1);
    expect(body.in_context_notes[0]?.["note_id"]).toBe("mem_seed_0014");
    expect(body.in_context_notes[0]?.["loaded_at"]).toBe(FROZEN_NOW.toISOString());
    expect(body.available_notes_count).toBe(20);
    // Schema still valid.
    const validator = schemaRegistry["memory-state-response"];
    expect(validator(body), JSON.stringify(validator.errors ?? [])).toBe(true);
  });

  it("not-a-side-effect: read does NOT mutate the underlying state (two reads see same loaded_at + consolidation.last_run_at)", async () => {
    ctx.memoryStore.recordLoad(
      SESSION,
      [
        {
          note_id: "mem_seed_0001",
          summary: "User prefers Python for data analysis tasks.",
          data_class: "internal",
          composite_score: 0.5
        }
      ],
      20
    );
    const a = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const b = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const aBody = JSON.parse(a.body) as {
      in_context_notes: Array<{ loaded_at: string }>;
      consolidation: { last_run_at: string };
    };
    const bBody = JSON.parse(b.body) as {
      in_context_notes: Array<{ loaded_at: string }>;
      consolidation: { last_run_at: string };
    };
    expect(aBody.in_context_notes[0]?.loaded_at).toBe(bBody.in_context_notes[0]?.loaded_at);
    expect(aBody.consolidation.last_run_at).toBe(bBody.consolidation.last_run_at);
  });

  it("auth + readiness matrix: 400 / 401 / 403 / 404 / 429 / 503", async () => {
    // 401 missing bearer
    const noAuth = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`
    });
    expect(noAuth.statusCode).toBe(401);

    // 400 malformed session_id
    const bad = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/bogus`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(bad.statusCode).toBe(400);

    // 404 unknown session (valid pattern, not registered in sessionStore)
    const unknown = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/ses_nonexistentfixture01`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(unknown.statusCode).toBe(404);

    // 403 wrong bearer
    const wrong = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer different-bearer` }
    });
    expect(wrong.statusCode).toBe(403);

    // 429 rate-limit
    const small = await newApp({ requestsPerMinute: 1 });
    try {
      const a = await small.app.inject({
        method: "GET",
        url: `/memory/state/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b = await small.app.inject({
        method: "GET",
        url: `/memory/state/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(429);
    } finally {
      await small.app.close();
    }

    // 503 pre-boot
    const preBoot = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    try {
      const r = await preBoot.app.inject({
        method: "GET",
        url: `/memory/state/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(r.statusCode).toBe(503);
    } finally {
      await preBoot.app.close();
    }
  });

  it("uninitialized memory state: session exists but no initFor() call → 404 memory-state-not-initialized", async () => {
    const fresh = await newApp({ initMemory: false });
    try {
      const res = await fresh.app.inject({
        method: "GET",
        url: `/memory/state/${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("memory-state-not-initialized");
    } finally {
      await fresh.app.close();
    }
  });

  it("consolidation recording updates pending_notes + last_run_at deterministically", async () => {
    ctx.memoryStore.recordConsolidation(SESSION, 3, 1, new Date("2026-04-22T00:00:00.000Z"));
    const res = await ctx.app.inject({
      method: "GET",
      url: `/memory/state/${SESSION}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      consolidation: { last_run_at: string; next_due_at?: string; pending_notes: number };
    };
    expect(body.consolidation.pending_notes).toBe(1);
    expect(body.consolidation.last_run_at).toBe(FROZEN_NOW.toISOString());
    expect(body.consolidation.next_due_at).toBe("2026-04-22T00:00:00.000Z");
  });
});
