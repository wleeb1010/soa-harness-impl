import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  HandlerKeyRegistry,
  handlerEnrollPlugin,
  keyStoragePlugin,
  appendSuspectDecisionsForKid
} from "../src/attestation/index.js";
import { AuditChain } from "../src/audit/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";

const FROZEN_NOW = new Date("2026-04-22T12:00:00.000Z");
const OPERATOR_BEARER = "bg-operator";
const SESSION_ID = "ses_bgFixture00000000001";
const SESSION_BEARER = "bg-session";

// ---------------------------------------------------------------------------
// BG — POST /handlers/enroll

async function newEnrollApp(registry: HandlerKeyRegistry) {
  const app = fastify();
  await app.register(handlerEnrollPlugin, {
    registry,
    readiness: { check: () => null },
    runnerVersion: "1.0",
    operatorBearer: OPERATOR_BEARER
  });
  return app;
}

describe("Finding BG — POST /handlers/enroll", () => {
  it("operator + valid EdDSA body → 201 enrolled=true", async () => {
    const reg = new HandlerKeyRegistry();
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {
          kid: "h1",
          spki: "deadbeef",
          algo: "EdDSA",
          issued_at: FROZEN_NOW.toISOString()
        }
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { enrolled: boolean; kid: string };
      expect(body.enrolled).toBe(true);
      expect(body.kid).toBe("h1");
      expect(reg.has("h1")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("duplicate kid → 409 HandlerKidConflict", async () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({
      kid: "h1",
      spki_hex: "aa",
      algo: "EdDSA",
      enrolled_at: FROZEN_NOW.toISOString()
    });
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {
          kid: "h1",
          spki: "bb",
          algo: "EdDSA",
          issued_at: FROZEN_NOW.toISOString()
        }
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("HandlerKidConflict");
    } finally {
      await app.close();
    }
  });

  it("RS256 → 400 AlgorithmRejected", async () => {
    const reg = new HandlerKeyRegistry();
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {
          kid: "h-rs256",
          spki: "aa",
          algo: "RS256",
          issued_at: FROZEN_NOW.toISOString()
        }
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("AlgorithmRejected");
    } finally {
      await app.close();
    }
  });

  it("RS3072 accepted (§10.6 legacy RSA ≥3072)", async () => {
    const reg = new HandlerKeyRegistry();
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: {
          kid: "h-rs",
          spki: "aa",
          algo: "RS3072",
          issued_at: FROZEN_NOW.toISOString()
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("malformed body → 400 malformed-body", async () => {
    const reg = new HandlerKeyRegistry();
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}`, "content-type": "application/json" },
        payload: { kid: "h1", spki: "" }
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("malformed-body");
    } finally {
      await app.close();
    }
  });

  it("non-operator bearer → 403", async () => {
    const reg = new HandlerKeyRegistry();
    const app = await newEnrollApp(reg);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/handlers/enroll",
        headers: { authorization: `Bearer not-operator`, "content-type": "application/json" },
        payload: {
          kid: "h1",
          spki: "aa",
          algo: "EdDSA",
          issued_at: FROZEN_NOW.toISOString()
        }
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BH — GET /security/key-storage

async function newKeyStorageApp() {
  const sessionStore = new InMemorySessionStore();
  sessionStore.register(SESSION_ID, SESSION_BEARER, { activeMode: "WorkspaceWrite" });
  const app = fastify();
  await app.register(keyStoragePlugin, {
    report: {
      storage_mode: "software-keystore",
      private_keys_on_disk: false,
      provider: "linux-keyring",
      attestation_format: "pkcs11"
    },
    sessionStore,
    readiness: { check: () => null },
    clock: () => FROZEN_NOW,
    runnerVersion: "1.0",
    operatorBearer: OPERATOR_BEARER
  });
  return app;
}

describe("Finding BH — GET /security/key-storage", () => {
  it("operator bearer → 200 with all 4 fields + generated_at", async () => {
    const app = await newKeyStorageApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/security/key-storage",
        headers: { authorization: `Bearer ${OPERATOR_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.storage_mode).toBe("software-keystore");
      expect(body.private_keys_on_disk).toBe(false);
      expect(body.provider).toBe("linux-keyring");
      expect(body.attestation_format).toBe("pkcs11");
      expect(typeof body.generated_at).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("session bearer (admin:read equivalent) → 200", async () => {
    const app = await newKeyStorageApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/security/key-storage",
        headers: { authorization: `Bearer ${SESSION_BEARER}` }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("missing bearer → 401", async () => {
    const app = await newKeyStorageApp();
    try {
      const res = await app.inject({ method: "GET", url: "/security/key-storage" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("unknown bearer → 403", async () => {
    const app = await newKeyStorageApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/security/key-storage",
        headers: { authorization: `Bearer unknown-token` }
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// BE-retroactive — SuspectDecision append

describe("Finding BE-retroactive — appendSuspectDecisionsForKid", () => {
  it("appends SuspectDecision admin-row per matching decision within 24h", () => {
    let nowMs = new Date("2026-04-22T10:00:00Z").getTime();
    const chain = new AuditChain(() => new Date(nowMs));
    // Append two decision rows for the suspect kid, one older than 24h.
    chain.append({
      id: "aud_1",
      session_id: SESSION_ID,
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "WorkspaceWrite",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "r",
      signer_key_id: "suspect-kid"
    });
    // Advance 23h55m — still within window.
    nowMs += 23 * 60 * 60 * 1000 + 55 * 60 * 1000;
    chain.append({
      id: "aud_2",
      session_id: SESSION_ID,
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "b".repeat(64),
      capability: "WorkspaceWrite",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "r",
      signer_key_id: "suspect-kid"
    });
    // One row from a different kid.
    chain.append({
      id: "aud_other",
      session_id: SESSION_ID,
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "c".repeat(64),
      capability: "WorkspaceWrite",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "r",
      signer_key_id: "other-kid"
    });
    const revokedAtIso = new Date(nowMs).toISOString();
    const result = appendSuspectDecisionsForKid({
      chain,
      kid: "suspect-kid",
      clock: () => new Date(nowMs),
      revokedAtIso
    });
    expect(result.flagged).toBe(2);
    const snap = chain.snapshot();
    const suspects = snap.filter((r) => r["decision"] === "SuspectDecision");
    expect(suspects.length).toBe(2);
    expect(suspects[0]?.["reason"]).toBe("kid-revoked-24h-window");
    const referenced = new Set(
      suspects.map((r) => r["referenced_audit_id"])
    );
    expect(referenced.has("aud_1")).toBe(true);
    expect(referenced.has("aud_2")).toBe(true);
  });

  it("skips rows outside the 24h window", () => {
    let nowMs = new Date("2026-04-22T00:00:00Z").getTime();
    const chain = new AuditChain(() => new Date(nowMs));
    chain.append({
      id: "aud_old",
      session_id: SESSION_ID,
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "WorkspaceWrite",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "r",
      signer_key_id: "k"
    });
    // 25h later — outside window.
    nowMs += 25 * 60 * 60 * 1000;
    const result = appendSuspectDecisionsForKid({
      chain,
      kid: "k",
      clock: () => new Date(nowMs),
      revokedAtIso: new Date(nowMs).toISOString()
    });
    expect(result.flagged).toBe(0);
  });

  it("SuspectDecision rows hash-chain (each referencing the prev hash)", () => {
    const nowMs = new Date("2026-04-22T12:00:00Z").getTime();
    const chain = new AuditChain(() => new Date(nowMs));
    chain.append({
      id: "aud_victim",
      session_id: SESSION_ID,
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "WorkspaceWrite",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "r",
      signer_key_id: "k"
    });
    appendSuspectDecisionsForKid({
      chain,
      kid: "k",
      clock: () => new Date(nowMs),
      revokedAtIso: new Date(nowMs).toISOString()
    });
    const snap = chain.snapshot();
    expect(snap.length).toBe(2);
    const suspect = snap[1]!;
    // prev_hash of suspect row === this_hash of original decision row.
    expect(suspect["prev_hash"]).toBe(snap[0]?.["this_hash"]);
    expect(suspect["decision"]).toBe("SuspectDecision");
  });
});
