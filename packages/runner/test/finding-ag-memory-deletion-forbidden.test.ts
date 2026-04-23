import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import {
  InMemoryMemoryStateStore,
  type MemoryMcpClient,
  type SearchedNote
} from "../src/memory/index.js";
import {
  SystemLogBuffer,
  systemLogRecentPlugin
} from "../src/system-log/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import {
  emitMemoryDeletionForbidden,
  partitionSensitivePersonal
} from "../src/privacy/index.js";

// Finding AG — MemoryDeletionForbidden must surface on /logs/system/recent
// when sensitive-personal notes appear on the memory prefetch path.

const FROZEN = new Date("2026-04-22T15:00:00.000Z");

describe("Finding AG — partitionSensitivePersonal helper", () => {
  it("splits notes into safe vs forbidden", () => {
    const out = partitionSensitivePersonal(
      [
        { note_id: "n1", data_class: "public" },
        { note_id: "n2", data_class: "sensitive-personal" },
        { note_id: "n3", data_class: "personal" },
        { note_id: "n4", data_class: "sensitive-personal" }
      ],
      "ses_a"
    );
    expect(out.safe.map((n) => n.note_id)).toEqual(["n1", "n3"]);
    expect(out.forbidden.map((n) => n.note_id)).toEqual(["n2", "n4"]);
  });

  it("emits one MemoryDeletionForbidden record per forbidden note", () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN });
    partitionSensitivePersonal(
      [
        { note_id: "n1", data_class: "sensitive-personal" },
        { note_id: "n2", data_class: "sensitive-personal" }
      ],
      "ses_b",
      buf
    );
    const records = buf.snapshot("ses_b");
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(r.category).toBe("Error");
      expect(r.level).toBe("error");
      expect(r.code).toBe("MemoryDeletionForbidden");
      expect(r.data?.reason).toBe("sensitive-class-forbidden");
    }
    expect(records.map((r) => r.data?.note_id).sort()).toEqual(["n1", "n2"]);
  });

  it("emitMemoryDeletionForbidden writes the canonical record shape", () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN });
    emitMemoryDeletionForbidden(buf, "ses_c", { note_id: "nx" });
    const [rec] = buf.snapshot("ses_c");
    expect(rec?.category).toBe("Error");
    expect(rec?.code).toBe("MemoryDeletionForbidden");
    expect(rec?.data?.note_id).toBe("nx");
    expect(rec?.message).toMatch(/sensitive-personal/);
  });
});

describe("Finding AG — bootstrap prefetch filters sensitive-personal + logs", () => {
  const BOOTSTRAP_BEARER = "ag-bootstrap";
  const SESSION_REQ = { requested_activeMode: "ReadOnly", user_sub: "alice-sub" };

  function buildStubClient(notes: readonly SearchedNote[]): MemoryMcpClient {
    return {
      async searchMemories() {
        return { hits: [...notes] };
      },
      async addMemoryNote() {
        throw new Error("unused");
      },
      async consolidateMemories() {
        return { consolidated_count: 0, pending_count: 0 };
      }
    } as unknown as MemoryMcpClient;
  }

  async function buildApp(notes: readonly SearchedNote[]) {
    const app = fastify();
    const store = new InMemorySessionStore();
    const memoryStore = new InMemoryMemoryStateStore({ clock: () => FROZEN });
    const emitter = new StreamEventEmitter({ clock: () => FROZEN });
    const systemLog = new SystemLogBuffer({ clock: () => FROZEN });
    const memoryClient = buildStubClient(notes);
    await app.register(sessionsBootstrapPlugin, {
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN,
      cardActiveMode: "WorkspaceWrite",
      bootstrapBearer: BOOTSTRAP_BEARER,
      memoryStore,
      emitter,
      memoryClient,
      systemLog
    });
    await app.register(systemLogRecentPlugin, {
      buffer: systemLog,
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN
    });
    return { app, memoryStore, systemLog, store };
  }

  it("sensitive-personal note is dropped from in-context state + logged to /logs/system/recent", async () => {
    const notes: SearchedNote[] = [
      {
        note_id: "n-safe",
        summary: "user prefers dark mode",
        data_class: "personal",
        composite_score: 0.6
      },
      {
        note_id: "n-forbidden",
        summary: "health condition",
        data_class: "sensitive-personal",
        composite_score: 0.9
      }
    ];
    const { app, memoryStore, systemLog } = await buildApp(notes);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: SESSION_REQ
      });
      expect(res.statusCode).toBe(201);
      const { session_id } = JSON.parse(res.body);

      // In-context state excludes the forbidden note; the safe note lands.
      const state = memoryStore.get(session_id);
      const inContext = state?.in_context_notes ?? [];
      expect(inContext.map((n) => n.note_id)).toEqual(["n-safe"]);

      // /logs/system/recent has one MemoryDeletionForbidden record for n-forbidden.
      const forbidden = systemLog
        .snapshot(session_id)
        .filter((r) => r.code === "MemoryDeletionForbidden");
      expect(forbidden.length).toBe(1);
      expect(forbidden[0]?.category).toBe("Error");
      expect(forbidden[0]?.level).toBe("error");
      expect(forbidden[0]?.data?.reason).toBe("sensitive-class-forbidden");
      expect(forbidden[0]?.data?.note_id).toBe("n-forbidden");
    } finally {
      await app.close();
    }
  });

  it("GET /logs/system/recent?category=Error surfaces MemoryDeletionForbidden for validator polling", async () => {
    const notes: SearchedNote[] = [
      {
        note_id: "n-f1",
        summary: "sensitive x",
        data_class: "sensitive-personal",
        composite_score: 0.5
      }
    ];
    const { app, store } = await buildApp(notes);
    try {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: SESSION_REQ
      });
      expect(bootstrap.statusCode).toBe(201);
      const { session_id, session_bearer } = JSON.parse(bootstrap.body);

      // Ensure bearer has sessions:read on this session (bootstrap grants it).
      void store;

      const logs = await app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${session_id}&category=Error`,
        headers: { authorization: `Bearer ${session_bearer}` }
      });
      expect(logs.statusCode).toBe(200);
      const body = JSON.parse(logs.body);
      const hits = body.records.filter(
        (r: { code: string }) => r.code === "MemoryDeletionForbidden"
      );
      expect(hits.length).toBe(1);
      expect(hits[0].data.reason).toBe("sensitive-class-forbidden");
    } finally {
      await app.close();
    }
  });

  it("no sensitive notes → no MemoryDeletionForbidden records emitted", async () => {
    const notes: SearchedNote[] = [
      {
        note_id: "ok",
        summary: "theme preference",
        data_class: "personal",
        composite_score: 0.4
      }
    ];
    const { app, systemLog } = await buildApp(notes);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: SESSION_REQ
      });
      expect(res.statusCode).toBe(201);
      const { session_id } = JSON.parse(res.body);
      const forbidden = systemLog
        .snapshot(session_id)
        .filter((r) => r.code === "MemoryDeletionForbidden");
      expect(forbidden.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});
