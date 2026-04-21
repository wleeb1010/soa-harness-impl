import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { AuditChain, auditRecordsPlugin } from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";
import type { ReadinessReason } from "../src/probes/index.js";

const FROZEN = new Date("2026-04-20T12:00:00.000Z");
const BEARER = "audit-read-bearer";

function schemaConformantRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Fields in EXACTLY the shape audit-records-response.schema.json's record
  // item requires. prev_hash + this_hash get filled in by AuditChain.append.
  return {
    id: `aud_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    timestamp: FROZEN.toISOString(),
    session_id: "ses_aaaaaaaaaaaaaaaa",
    subject_id: "none",
    tool: "fs__read_file",
    args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    capability: "DangerFullAccess",
    control: "AutoAllow",
    handler: "Interactive",
    decision: "AutoAllow",
    reason: "auto-allow-under-capability",
    signer_key_id: "",
    ...overrides
  };
}

async function newApp(overrides: { readinessReason?: ReadinessReason; requestsPerMinute?: number } = {}) {
  const app = fastify();
  const chain = new AuditChain(() => FROZEN);
  const store = new InMemorySessionStore();
  store.register("ses_probe", BEARER);
  await app.register(auditRecordsPlugin, {
    chain,
    sessionStore: store,
    readiness: { check: () => overrides.readinessReason ?? null },
    clock: () => FROZEN,
    runnerVersion: "1.0",
    ...(overrides.requestsPerMinute !== undefined ? { requestsPerMinute: overrides.requestsPerMinute } : {})
  });
  return { app, chain, store };
}

describe("GET /audit/records — §10.5.3 pagination", () => {
  const validate = schemaRegistry["audit-records-response"];

  it("(1) returns an empty page against an empty log", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "GET",
      url: "/audit/records",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(validate(body)).toBe(true);
    expect(body.records).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_after).toBeUndefined();
    expect(body.runner_version).toBe("1.0");
    await app.close();
  });

  it("(2) returns a single-record page after one append", async () => {
    const { app, chain } = await newApp();
    chain.append(schemaConformantRecord());
    const res = await app.inject({
      method: "GET",
      url: "/audit/records",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(validate(body)).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.has_more).toBe(false);
    expect(body.next_after).toBe(body.records[0].id);
    await app.close();
  });

  it("(3) traverses multi-page with next_after + has_more transitions", async () => {
    const { app, chain } = await newApp();
    for (let i = 0; i < 5; i++) chain.append(schemaConformantRecord({ tool: `t${i}` }));

    const first = await app.inject({
      method: "GET",
      url: "/audit/records?limit=2",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const firstBody = JSON.parse(first.body);
    expect(firstBody.records).toHaveLength(2);
    expect(firstBody.has_more).toBe(true);

    const second = await app.inject({
      method: "GET",
      url: `/audit/records?limit=2&after=${firstBody.next_after}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const secondBody = JSON.parse(second.body);
    expect(secondBody.records).toHaveLength(2);
    expect(secondBody.has_more).toBe(true);
    expect(secondBody.records[0].tool).toBe("t2");

    const third = await app.inject({
      method: "GET",
      url: `/audit/records?limit=2&after=${secondBody.next_after}`,
      headers: { authorization: `Bearer ${BEARER}` }
    });
    const thirdBody = JSON.parse(third.body);
    expect(thirdBody.records).toHaveLength(1);
    expect(thirdBody.has_more).toBe(false);
    expect(thirdBody.records[0].tool).toBe("t4");

    await app.close();
  });

  it("(4) 404 when after= references an unknown id", async () => {
    const { app, chain } = await newApp();
    chain.append(schemaConformantRecord());
    const res = await app.inject({
      method: "GET",
      url: "/audit/records?after=aud_doesnotexist",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("(5) 403 when bearer is not tied to any session (no audit:read scope)", async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: "GET",
      url: "/audit/records",
      headers: { authorization: "Bearer random-bearer" }
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("(6) 429 when rate limit exhausted", async () => {
    const { app } = await newApp({ requestsPerMinute: 2 });
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: "GET",
        url: "/audit/records",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/audit/records",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("(7) not-a-side-effect: reading twice leaves tail/count unchanged", async () => {
    const { app, chain } = await newApp();
    chain.append(schemaConformantRecord());
    chain.append(schemaConformantRecord({ tool: "second" }));
    const tailBefore = chain.tailHash();
    const countBefore = chain.recordCount();

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/audit/records",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
    }

    expect(chain.tailHash()).toBe(tailBefore);
    expect(chain.recordCount()).toBe(countBefore);
    await app.close();
  });

  it("503 when readiness is pending", async () => {
    const { app } = await newApp({ readinessReason: "bootstrap-pending" });
    const res = await app.inject({
      method: "GET",
      url: "/audit/records",
      headers: { authorization: `Bearer ${BEARER}` }
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).reason).toBe("bootstrap-pending");
    await app.close();
  });
});
