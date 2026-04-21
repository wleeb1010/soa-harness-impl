import { describe, it, expect, beforeEach } from "vitest";
import { fastify } from "fastify";
import { CompactSign } from "jose";
import { jcsBytes } from "@soa-harness/core";
import {
  permissionsDecisionsPlugin,
  InMemorySessionStore,
  type SessionStore
} from "../src/permission/index.js";
import { ToolRegistry, loadToolRegistry } from "../src/registry/index.js";
import { AuditChain, GENESIS } from "../src/audit/index.js";
import { generateEd25519KeyPair } from "../src/card/cert.js";
import type { ReadinessProbe, ReadinessReason } from "../src/probes/index.js";
import type { CanonicalDecision } from "../src/attestation/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, "fixtures", "tools.sample.json");
const FROZEN = new Date("2026-04-20T12:00:00.000Z");
const RUNNER_VERSION = "1.0";
const KID = "kid-handler-test";

function readyProbe(reason: ReadinessReason | null = null): ReadinessProbe {
  return { check: () => reason };
}

function baseDecision(overrides: Partial<CanonicalDecision> = {}): CanonicalDecision {
  return {
    prompt_id: "prm_a1b2c3d4e5f6",
    session_id: "ses_placeholder",
    tool_name: "fs__write_file",
    args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    decision: "allow",
    scope: "once",
    not_before: "2026-04-20T11:59:00.000Z",
    not_after: "2026-04-20T12:05:00.000Z",
    nonce: "q9Zt-X8bL4rFvH2kNpR7wS",
    handler_kid: KID,
    ...overrides
  };
}

async function buildTestApp(
  overrides: {
    activeCapability?: "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
    readiness?: ReadinessProbe;
    requestsPerMinute?: number;
    resolvePdaVerifyKey?: ReturnType<typeof mkKeyResolver>;
  } = {},
  registryOverride?: ToolRegistry
) {
  const app = fastify();
  const store = new InMemorySessionStore();
  const chain = new AuditChain(() => FROZEN);
  const reg = registryOverride ?? loadToolRegistry(TOOLS);
  await app.register(permissionsDecisionsPlugin, {
    registry: reg,
    sessionStore: store,
    chain,
    readiness: overrides.readiness ?? readyProbe(),
    clock: () => FROZEN,
    activeCapability: overrides.activeCapability ?? "DangerFullAccess",
    runnerVersion: RUNNER_VERSION,
    ...(overrides.requestsPerMinute !== undefined ? { requestsPerMinute: overrides.requestsPerMinute } : {}),
    ...(overrides.resolvePdaVerifyKey !== undefined ? { resolvePdaVerifyKey: overrides.resolvePdaVerifyKey } : {})
  });
  return { app, store, chain, registry: reg };
}

function mkKeyResolver(keys: CryptoKeyPair) {
  return async (kid: string) => (kid === KID ? keys.publicKey : null);
}

describe("POST /permissions/decisions — §10.3.2", () => {
  const BEARER = "test-bearer-decisions";

  it("(1) AutoAllow tool with no PDA → 201, audit row written, tail advances", async () => {
    const { app, store, chain } = await buildTestApp({ activeCapability: "DangerFullAccess" });
    store.register("ses_aaaaaaaaaaaaaaaa", BEARER, { activeMode: "DangerFullAccess", canDecide: true });
    expect(chain.tailHash()).toBe(GENESIS);
    expect(chain.recordCount()).toBe(0);

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__read_file",
        session_id: "ses_aaaaaaaaaaaaaaaa",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      })
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("AutoAllow");
    expect(body.handler_accepted).toBe(true);
    expect(body.audit_record_id).toMatch(/^aud_[A-Za-z0-9_-]{8,}$/);
    expect(body.audit_this_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(chain.recordCount()).toBe(1);
    expect(chain.tailHash()).toBe(body.audit_this_hash);
    await app.close();
  });

  it("(2) Prompt tool with valid PDA → 201, audit row carries pda_signer_kid", async () => {
    const keys = await generateEd25519KeyPair();
    const { app, store, chain } = await buildTestApp({
      activeCapability: "DangerFullAccess",
      resolvePdaVerifyKey: mkKeyResolver(keys)
    });
    store.register("ses_bbbbbbbbbbbbbbbb", BEARER, { activeMode: "DangerFullAccess", canDecide: true });

    const decision = baseDecision({ session_id: "ses_bbbbbbbbbbbbbbbb" });
    const pdaJws = await new CompactSign(jcsBytes(decision))
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-pda+jws" })
      .sign(keys.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__write_file",
        session_id: "ses_bbbbbbbbbbbbbbbb",
        args_digest: decision.args_digest,
        pda: pdaJws
      })
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("Prompt");
    expect(body.handler_accepted).toBe(true);
    expect(chain.recordCount()).toBe(1);
    const snap = chain.snapshot()[0] as Record<string, unknown>;
    expect(snap.pda_signer_kid).toBe(KID);
    await app.close();
  });

  it("(3) Prompt tool with crypto-invalid PDA → 201 Deny+pda-verify-failed, audited", async () => {
    const verifierKeys = await generateEd25519KeyPair();
    const signerKeys = await generateEd25519KeyPair();
    const { app, store, chain } = await buildTestApp({
      activeCapability: "DangerFullAccess",
      resolvePdaVerifyKey: mkKeyResolver(verifierKeys)
    });
    store.register("ses_cccccccccccccccc", BEARER, { activeMode: "DangerFullAccess", canDecide: true });

    // Sign with the WRONG key (verifier resolves the "right" key by kid, so
    // the signature fails cryptographically).
    const decision = baseDecision({ session_id: "ses_cccccccccccccccc" });
    const pdaJws = await new CompactSign(jcsBytes(decision))
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-pda+jws" })
      .sign(signerKeys.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__write_file",
        session_id: "ses_cccccccccccccccc",
        args_digest: decision.args_digest,
        pda: pdaJws
      })
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("Deny");
    expect(body.handler_accepted).toBe(false);
    expect(body.reason).toBe("pda-verify-failed");
    expect(chain.recordCount()).toBe(1); // attempt is audited
    await app.close();
  });

  it("(4) 403 when bearer lacks permissions:decide scope", async () => {
    const { app, store } = await buildTestApp();
    // Missing canDecide:true
    store.register("ses_dddddddddddddddd", BEARER, { activeMode: "DangerFullAccess", canDecide: false });
    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__read_file",
        session_id: "ses_dddddddddddddddd",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      })
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("insufficient-scope");
    await app.close();
  });

  it("(5) 403 pda-decision-mismatch when resolver=AutoAllow but PDA says deny", async () => {
    const keys = await generateEd25519KeyPair();
    const { app, store } = await buildTestApp({
      activeCapability: "DangerFullAccess",
      resolvePdaVerifyKey: mkKeyResolver(keys)
    });
    store.register("ses_eeeeeeeeeeeeeeee", BEARER, { activeMode: "DangerFullAccess", canDecide: true });

    const decision = baseDecision({
      session_id: "ses_eeeeeeeeeeeeeeee",
      tool_name: "fs__read_file",
      decision: "deny"
    });
    const pdaJws = await new CompactSign(jcsBytes(decision))
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-pda+jws" })
      .sign(keys.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__read_file", // AutoAllow under DangerFullAccess
        session_id: "ses_eeeeeeeeeeeeeeee",
        args_digest: decision.args_digest,
        pda: pdaJws
      })
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("pda-decision-mismatch");
    await app.close();
  });

  it("(6) 400 on malformed PDA (not three segments)", async () => {
    const keys = await generateEd25519KeyPair();
    const { app, store } = await buildTestApp({
      activeCapability: "DangerFullAccess",
      resolvePdaVerifyKey: mkKeyResolver(keys)
    });
    store.register("ses_ffffffffffffffff", BEARER, { activeMode: "DangerFullAccess", canDecide: true });

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__write_file",
        session_id: "ses_ffffffffffffffff",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pda: "not.a.jws.with.too.many.segments"
      })
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("(6b) §10.3.2 L-23: PDA supplied but resolvePdaVerifyKey unconfigured → 503 pda-verify-unavailable", async () => {
    // Build an app WITHOUT resolvePdaVerifyKey — the L-23 server-state branch.
    const { app, store } = await buildTestApp({ activeCapability: "DangerFullAccess" });
    store.register("ses_gggggggggggggggg", BEARER, { activeMode: "DangerFullAccess", canDecide: true });
    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__write_file",
        session_id: "ses_gggggggggggggggg",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pda: "header.payload.signature"
      })
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("pda-verify-unavailable");
    expect(body.reason).toBe("pda-verify-unavailable");
    await app.close();
  });

  it("(7) 429 when rate limit exhausted", async () => {
    const { app, store } = await buildTestApp({ requestsPerMinute: 2 });
    store.register("ses_1111111111111111", BEARER, { activeMode: "DangerFullAccess", canDecide: true });
    const payload = JSON.stringify({
      tool: "fs__read_file",
      session_id: "ses_1111111111111111",
      args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    });
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload
      });
      expect(ok.statusCode).toBe(201);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("(8) 503 pre-boot when /ready is 503", async () => {
    const { app, store } = await buildTestApp({ readiness: readyProbe("bootstrap-pending") });
    store.register("ses_2222222222222222", BEARER, { activeMode: "DangerFullAccess", canDecide: true });
    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__read_file",
        session_id: "ses_2222222222222222",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      })
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).reason).toBe("bootstrap-pending");
    await app.close();
  });

  it("(9) forgery resistance: decision equals /permissions/resolve output for same (tool, session_id)", async () => {
    const { app, store } = await buildTestApp({ activeCapability: "WorkspaceWrite" });
    store.register("ses_3333333333333333", BEARER, { activeMode: "ReadOnly", canDecide: true });

    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__write_file", // Mutating; under ReadOnly session → CapabilityDenied
        session_id: "ses_3333333333333333",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      })
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("CapabilityDenied");
    expect(body.resolved_capability).toBe("ReadOnly"); // pulled from session, not card
    await app.close();
  });

  it("response body validates against permission-decision-response.schema.json", async () => {
    const { app, store } = await buildTestApp();
    store.register("ses_4444444444444444", BEARER, { activeMode: "DangerFullAccess", canDecide: true });
    const res = await app.inject({
      method: "POST",
      url: "/permissions/decisions",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: JSON.stringify({
        tool: "fs__read_file",
        session_id: "ses_4444444444444444",
        args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      })
    });
    const { registry: schemas } = await import("@soa-harness/schemas");
    const validate = schemas["permission-decision-response"];
    expect(validate(JSON.parse(res.body))).toBe(true);
    await app.close();
  });
});
