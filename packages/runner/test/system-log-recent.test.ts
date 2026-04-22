import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  SystemLogBuffer,
  SYSTEM_LOG_CATEGORIES,
  SystemLogCategoryInvalid,
  isSystemLogCategory,
  systemLogRecentPlugin
} from "../src/system-log/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import { registry as schemas } from "@soa-harness/schemas";

// L-38 §14.5.4 /logs/system/recent — polling System Event Log observability.

const FROZEN_NOW = new Date("2026-04-22T07:00:00.000Z");
const SESSION = "ses_syslogfixture000000001";
const BEARER = "syslog-bearer";

describe("SystemLogBuffer — §14.5.4 closed-enum category + level", () => {
  it("exports exactly 12 canonical categories", () => {
    expect(SYSTEM_LOG_CATEGORIES).toHaveLength(12);
    expect(SYSTEM_LOG_CATEGORIES).toContain("MemoryDegraded");
    expect(SYSTEM_LOG_CATEGORIES).toContain("Budget");
    expect(SYSTEM_LOG_CATEGORIES).toContain("Error");
    expect(isSystemLogCategory("MemoryDegraded")).toBe(true);
    expect(isSystemLogCategory("NotARealCategory")).toBe(false);
  });

  it("write() rejects non-enum category", () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    expect(() =>
      buf.write({
        session_id: SESSION,
        category: "NotARealCategory",
        level: "info",
        code: "x",
        message: "y"
      })
    ).toThrow(SystemLogCategoryInvalid);
  });

  it("record_id uses slog_ prefix + hex; maxLength 1024 truncation on message", () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    const huge = "x".repeat(2048);
    const rec = buf.write({
      session_id: SESSION,
      category: "MemoryDegraded",
      level: "warn",
      code: "memory-timeout",
      message: huge
    });
    expect(rec.record_id).toMatch(/^slog_[0-9a-f]{12}$/);
    expect(rec.message.length).toBe(1024);
    expect(rec.ts).toBe(FROZEN_NOW.toISOString());
  });

  it("snapshot() with category filter returns only matching entries; unfiltered returns all", () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    buf.write({ session_id: SESSION, category: "MemoryDegraded", level: "warn", code: "a", message: "a" });
    buf.write({ session_id: SESSION, category: "Budget", level: "info", code: "b", message: "b" });
    buf.write({ session_id: SESSION, category: "MemoryDegraded", level: "warn", code: "c", message: "c" });
    expect(buf.snapshot(SESSION)).toHaveLength(3);
    expect(buf.snapshot(SESSION, new Set(["MemoryDegraded"] as const))).toHaveLength(2);
    expect(buf.snapshot(SESSION, new Set(["Budget"] as const))).toHaveLength(1);
    expect(buf.snapshot(SESSION, new Set(["Error"] as const))).toHaveLength(0);
  });
});

async function newApp(buf: SystemLogBuffer) {
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION, BEARER, { activeMode: "ReadOnly", canDecide: false });
  const app = fastify();
  await app.register(systemLogRecentPlugin, {
    buffer: buf,
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0"
  });
  return { app, sessionStore };
}

describe("§14.5.4 GET /logs/system/recent — route", () => {
  it("cold-state empty buffer: 200 with records:[], schema-valid body", async () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    const ctx = await newApp(buf);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.records).toEqual([]);
      expect(body.has_more).toBe(false);
      expect(schemas["system-log-recent-response"](body)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("populated buffer: returns records in append order with pagination", async () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    for (let i = 0; i < 3; i++) {
      buf.write({
        session_id: SESSION,
        category: "Budget",
        level: "info",
        code: `rec-${i}`,
        message: `m-${i}`
      });
    }
    const ctx = await newApp(buf);
    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}&limit=2`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.records).toHaveLength(2);
      expect(body.has_more).toBe(true);
      expect(body.next_after).toBe(body.records[1].record_id);
      expect(schemas["system-log-recent-response"](body)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });

  it("category filter: comma-separated closed-enum values; unknown → 400", async () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    buf.write({ session_id: SESSION, category: "MemoryDegraded", level: "warn", code: "m", message: "m" });
    buf.write({ session_id: SESSION, category: "Budget", level: "info", code: "b", message: "b" });
    buf.write({ session_id: SESSION, category: "Permission", level: "info", code: "p", message: "p" });
    const ctx = await newApp(buf);
    try {
      const filtered = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}&category=Budget,Permission`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(filtered.statusCode).toBe(200);
      const body = JSON.parse(filtered.body);
      expect(body.records.map((r: { code: string }) => r.code).sort()).toEqual(["b", "p"]);

      const bad = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}&category=NotARealCategory`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(bad.statusCode).toBe(400);
      expect(JSON.parse(bad.body).error).toBe("unknown-category");
    } finally {
      await ctx.app.close();
    }
  });

  it("missing bearer → 401; wrong-session bearer → 403; unknown after → 404", async () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    const ctx = await newApp(buf);
    try {
      const unauth = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}`
      });
      expect(unauth.statusCode).toBe(401);

      const wrong = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer not-the-right-bearer` }
      });
      expect(wrong.statusCode).toBe(403);

      const missing = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}&after=slog_doesnotexist12345`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await ctx.app.close();
    }
  });

  it("NOT-A-SIDE-EFFECT: two reads byte-identical; buffer count unchanged", async () => {
    const buf = new SystemLogBuffer({ clock: () => FROZEN_NOW });
    buf.write({ session_id: SESSION, category: "Config", level: "info", code: "c", message: "c" });
    const ctx = await newApp(buf);
    try {
      const r1 = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const r2 = await ctx.app.inject({
        method: "GET",
        url: `/logs/system/recent?session_id=${SESSION}`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      const b1 = JSON.parse(r1.body);
      const b2 = JSON.parse(r2.body);
      delete b1.generated_at;
      delete b2.generated_at;
      expect(b1).toEqual(b2);
      expect(buf.snapshot(SESSION)).toHaveLength(1);
    } finally {
      await ctx.app.close();
    }
  });
});
