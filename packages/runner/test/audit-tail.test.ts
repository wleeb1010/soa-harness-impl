import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import {
  AuditChain,
  auditTailPlugin,
  GENESIS
} from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";

const FROZEN = new Date("2026-04-20T12:00:00.000Z");

async function newApp(overrides: { readiness?: { check: () => string | null } } = {}) {
  const app = fastify();
  const chain = new AuditChain(() => FROZEN);
  const sessionStore = new InMemorySessionStore();
  sessionStore.register("ses_any", "bearer-xyz");
  await app.register(auditTailPlugin, {
    chain,
    sessionStore,
    readiness: overrides.readiness ?? { check: () => null },
    clock: () => FROZEN,
    runnerVersion: "1.0",
    requestsPerMinute: 120
  });
  return { app, chain, sessionStore };
}

describe("GET /audit/tail — happy path (§10.5.2)", () => {
  it("returns 200 with GENESIS + record_count:0 on an empty log", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer bearer-xyz" }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(schemaRegistry["audit-tail-response"](body)).toBe(true);
    expect(body.this_hash).toBe(GENESIS);
    expect(body.record_count).toBe(0);
    expect(body.last_record_timestamp).toBeUndefined();
    expect(body.runner_version).toBe("1.0");
    await app.close();
  });

  it("returns 200 with real tail hash after writing a record", async () => {
    const { app, chain } = await newApp();
    chain.append({ kind: "test", note: "first record" });
    const res = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer bearer-xyz" }
    });
    const body = JSON.parse(res.body);
    expect(schemaRegistry["audit-tail-response"](body)).toBe(true);
    expect(body.this_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.record_count).toBe(1);
    expect(body.last_record_timestamp).toBe(FROZEN.toISOString());
    await app.close();
  });

  it("chain is hash-linked: appending updates tail + count", async () => {
    const { chain } = await newApp();
    const first = chain.append({ kind: "a" });
    const second = chain.append({ kind: "b" });
    expect(second.prev_hash).toBe(first.this_hash);
    expect(chain.tailHash()).toBe(second.this_hash);
    expect(chain.recordCount()).toBe(2);
  });
});

describe("GET /audit/tail — auth + gates", () => {
  it("returns 401 when no bearer is presented", async () => {
    const { app } = await newApp();
    const res = await app.inject({ method: "GET", url: "/audit/tail" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 403 when the bearer is not tied to any known session", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer random-unknown" }
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 503 {reason} when readiness is pending", async () => {
    const { app } = await newApp({ readiness: { check: () => "bootstrap-pending" } });
    const res = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer bearer-xyz" }
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).reason).toBe("bootstrap-pending");
    await app.close();
  });
});

describe("GET /audit/tail — not-a-side-effect property (§10.5.2)", () => {
  it("two sequential reads leave record_count and tail hash unchanged", async () => {
    const { app, chain } = await newApp();
    chain.append({ kind: "seed" });
    const first = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer bearer-xyz" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/audit/tail",
      headers: { authorization: "Bearer bearer-xyz" }
    });
    const f = JSON.parse(first.body);
    const s = JSON.parse(second.body);
    expect(f.this_hash).toBe(s.this_hash);
    expect(f.record_count).toBe(s.record_count);
    expect(f.last_record_timestamp).toBe(s.last_record_timestamp);
    await app.close();
  });

  it("write → read → read: record_count unchanged across the two reads", async () => {
    const { app, chain } = await newApp();
    chain.append({ kind: "seed-1" });
    const before = JSON.parse(
      (await app.inject({ method: "GET", url: "/audit/tail", headers: { authorization: "Bearer bearer-xyz" } })).body
    );
    const after = JSON.parse(
      (await app.inject({ method: "GET", url: "/audit/tail", headers: { authorization: "Bearer bearer-xyz" } })).body
    );
    expect(before.record_count).toBe(after.record_count);
    expect(before.this_hash).toBe(after.this_hash);
    await app.close();
  });
});
