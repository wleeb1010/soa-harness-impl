import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { permissionsDecisionsPlugin, InMemorySessionStore } from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { auditRecordsPlugin } from "../src/audit/index.js";
import { registry as schemas } from "@soa-harness/schemas";

// Finding AB / SV-BUD-05 — L-40 billing_tag embed:
//   - Audit row carries billing_tag when the session does; response validates
//     against audit-records-response.schema.json AFTER the L-40 extension.
//   - PermissionDecision StreamEvent payload carries billing_tag likewise.
//   - When the session has no billing_tag, the field is ABSENT (not "") so
//     hash-chain content stays consistent across cards with/without billing.

const FROZEN_NOW = new Date("2026-04-22T14:00:00.000Z");
const SESSION = "ses_abbillingfixture000001";
const BEARER = "ab-bearer";
const BILLING_TAG = "conformance-test";

async function buildApp(billingTag: string | undefined) {
  const store = new InMemorySessionStore();
  store.register(SESSION, BEARER, {
    activeMode: "WorkspaceWrite",
    canDecide: true,
    ...(billingTag !== undefined ? { billing_tag: billingTag } : {})
  });
  const chain = new AuditChain(() => FROZEN_NOW);
  const registry = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
  ]);
  const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
  const app = fastify();
  await app.register(permissionsDecisionsPlugin, {
    registry,
    sessionStore: store,
    chain,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    activeCapability: "WorkspaceWrite",
    runnerVersion: "1.0",
    emitter
  });
  await app.register(auditRecordsPlugin, {
    chain,
    sessionStore: store,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0"
  });
  return { app, store, chain, emitter };
}

describe("Finding AB — billing_tag in audit rows + PermissionDecision events", () => {
  it("session with billing_tag: audit row carries it; PermissionDecision event carries it; /audit/records response validates", async () => {
    const ctx = await buildApp(BILLING_TAG);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:aaaa111111111111111111111111111111111111111111111111111111111111"
        }
      });
      expect(res.statusCode).toBe(201);

      // Audit row (internal) carries billing_tag.
      const rows = ctx.chain.snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.billing_tag).toBe(BILLING_TAG);

      // /audit/records response schema-validates with billing_tag present.
      const ar = await ctx.app.inject({
        method: "GET",
        url: `/audit/records?limit=50`,
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(ar.statusCode).toBe(200);
      const arBody = JSON.parse(ar.body);
      const ok = schemas["audit-records-response"](arBody);
      if (!ok) console.error("schema errors:", (schemas["audit-records-response"] as unknown as { errors?: unknown }).errors);
      expect(ok).toBe(true);
      expect(arBody.records[0].billing_tag).toBe(BILLING_TAG);

      // PermissionDecision StreamEvent payload carries billing_tag.
      const events = ctx.emitter.snapshot(SESSION);
      const pd = events.find((e) => e.type === "PermissionDecision")!;
      expect(pd.payload.billing_tag).toBe(BILLING_TAG);
    } finally {
      await ctx.app.close();
    }
  });

  it("session without billing_tag: audit row OMITS the field (not empty string); stream event OMITS it too", async () => {
    const ctx = await buildApp(undefined);
    try {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbb222222222222222222222222222222222222222222222222222222222222"
        }
      });
      expect(res.statusCode).toBe(201);

      const rows = ctx.chain.snapshot();
      // Key is LITERALLY ABSENT so the canonical JCS hash-chain content
      // matches across billing/non-billing deployments. Per L-40:
      // "DO NOT emit billing_tag='' as a placeholder".
      expect("billing_tag" in rows[0]!).toBe(false);

      const events = ctx.emitter.snapshot(SESSION);
      const pd = events.find((e) => e.type === "PermissionDecision")!;
      expect("billing_tag" in pd.payload).toBe(false);
    } finally {
      await ctx.app.close();
    }
  });
});
