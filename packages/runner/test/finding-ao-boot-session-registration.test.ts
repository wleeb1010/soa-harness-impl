import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { BOOT_SESSION_ID, InMemorySessionStore } from "../src/permission/index.js";
import {
  SystemLogBuffer,
  systemLogRecentPlugin
} from "../src/system-log/index.js";

// Finding AO — runner-boot session registration. /logs/system/recent
// accepts the boot session_id and the bootstrap bearer can read
// boot-lifetime records (retention sweeps, consolidation, startup probe,
// ConfigPrecedenceViolation) through the existing §14.5.4 endpoint.

const FROZEN = new Date("2026-04-22T15:00:00.000Z");
const BOOTSTRAP_BEARER = "ao-bootstrap";

describe("Finding AO — boot session registration", () => {
  it("BOOT_SESSION_ID matches the §12.1 pattern", () => {
    expect(BOOT_SESSION_ID).toMatch(/^ses_[A-Za-z0-9]{16,}$/);
  });

  async function buildApp() {
    const app = fastify();
    const store = new InMemorySessionStore();
    const buffer = new SystemLogBuffer({ clock: () => FROZEN });
    // Emulate start-runner's boot registration.
    store.register(BOOT_SESSION_ID, BOOTSTRAP_BEARER, {
      activeMode: "ReadOnly",
      user_sub: "runner-boot",
      canDecide: false
    });
    // Seed a retention-sweep + startup-probe record.
    buffer.write({
      session_id: BOOT_SESSION_ID,
      category: "ContextLoad",
      level: "info",
      code: "retention-sweep-ran",
      message: "sweep 1",
      data: { records_tombstoned_memory: 0 }
    });
    buffer.write({
      session_id: BOOT_SESSION_ID,
      category: "Error",
      level: "error",
      code: "ConfigPrecedenceViolation",
      message: "explore agentType with DangerFullAccess",
      data: { agentType: "explore", activeMode: "DangerFullAccess" }
    });
    await app.register(systemLogRecentPlugin, {
      buffer,
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN
    });
    return { app, store, buffer };
  }

  it("bootstrap bearer can read boot-session logs via /logs/system/recent", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${BOOT_SESSION_ID}`,
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.records.length).toBe(2);
      const codes = body.records.map((r: { code: string }) => r.code).sort();
      expect(codes).toEqual(["ConfigPrecedenceViolation", "retention-sweep-ran"]);
    } finally {
      await app.close();
    }
  });

  it("wrong bearer is rejected with 403 session-bearer-mismatch", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${BOOT_SESSION_ID}`,
        headers: { authorization: `Bearer not-the-bearer` }
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("session-bearer-mismatch");
    } finally {
      await app.close();
    }
  });

  it("category=Error filter narrows to ConfigPrecedenceViolation", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${BOOT_SESSION_ID}&category=Error`,
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.records.length).toBe(1);
      expect(body.records[0].code).toBe("ConfigPrecedenceViolation");
    } finally {
      await app.close();
    }
  });

  it("unregistered session_id returns 404 unknown-session", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=ses_nonExistent000000`,
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}` }
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe("unknown-session");
    } finally {
      await app.close();
    }
  });
});
