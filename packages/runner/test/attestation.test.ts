import { describe, it, expect } from "vitest";
import { CompactSign } from "jose";
import { jcsBytes } from "@soa-harness/core";
import {
  generateEd25519KeyPair
} from "../src/card/cert.js";
import {
  verifyPda,
  PdaVerifyFailed,
  type CanonicalDecision,
  type HandlerKeyResolver
} from "../src/attestation/index.js";

const KID = "kid-handler-2026-04-example-ed25519";

function baseDecision(overrides: Partial<CanonicalDecision> = {}): CanonicalDecision {
  return {
    prompt_id: "prm_a1b2c3d4e5f6",
    session_id: "ses_7fce271312c1824bf9",
    tool_name: "fs__write_file",
    args_digest: "sha256:3e2374b2fcb7c82a7f0e6b1a5d0fe5f2c8a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
    decision: "allow",
    scope: "once",
    not_before: "2026-04-18T12:01:05.000Z",
    not_after: "2026-04-18T12:05:30.000Z",
    nonce: "q9Zt-X8bL4rFvH2kNpR7wS",
    handler_kid: KID,
    ...overrides
  };
}

async function signPda(
  decision: CanonicalDecision,
  keys: CryptoKeyPair,
  headerOverrides: Record<string, unknown> = {}
): Promise<string> {
  const payload = jcsBytes(decision);
  return new CompactSign(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: decision.handler_kid, typ: "soa-pda+jws", ...headerOverrides })
    .sign(keys.privateKey);
}

describe("verifyPda", () => {
  it("verifies a well-formed PDA signed by an enrolled kid", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    const resolver: HandlerKeyResolver = async (kid) => (kid === KID ? keys.publicKey : null);
    const result = await verifyPda({ pdaJws: jws, resolveVerifyKey: resolver, now });

    expect(result.decision.decision).toBe("allow");
    expect(result.decision.handler_kid).toBe(KID);
    expect(result.protectedHeader.typ).toBe("soa-pda+jws");
  });

  it("rejects typ other than soa-pda+jws", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys, { typ: "soa-agent-card+jws" });
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "typ-mismatch" });
  });

  it("rejects when handler_kid in payload does not match header kid", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision({ handler_kid: "kid-mismatched" });
    const jws = await signPda({ ...decision, handler_kid: KID }, keys, { kid: "kid-different-in-header" });
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "kid-mismatch" });
  });

  it("rejects a PDA whose window exceeds 15 minutes", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision({
      not_before: "2026-04-18T12:00:00.000Z",
      not_after: "2026-04-18T12:20:00.000Z"
    });
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T12:05:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "window-too-wide" });
  });

  it("rejects a PDA that has not yet entered its not_before window", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T11:59:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "not-yet-valid" });
  });

  it("rejects a PDA past its not_after window", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T12:07:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects a PDA whose kid is not in the enrollment store", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => null, now })
    ).rejects.toMatchObject({ reason: "handler-key-unknown" });
  });

  it("rejects a PDA whose kid is on the CRL", async () => {
    const keys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, keys);
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({
        pdaJws: jws,
        resolveVerifyKey: async () => keys.publicKey,
        isRevoked: async () => true,
        now
      })
    ).rejects.toMatchObject({ reason: "handler-key-revoked" });
  });

  it("rejects when the signature does not verify against the resolved key", async () => {
    const signerKeys = await generateEd25519KeyPair();
    const decoyKeys = await generateEd25519KeyPair();
    const decision = baseDecision();
    const jws = await signPda(decision, signerKeys);
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => decoyKeys.publicKey, now })
    ).rejects.toMatchObject({ reason: "signature-invalid" });
  });

  it("rejects a payload that fails canonical-decision.schema.json", async () => {
    const keys = await generateEd25519KeyPair();
    // Missing required fields
    const decision = { decision: "allow" } as unknown as CanonicalDecision;
    const jws = await new CompactSign(jcsBytes(decision))
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-pda+jws" })
      .sign(keys.privateKey);
    const now = () => new Date("2026-04-18T12:03:00.000Z");

    await expect(
      verifyPda({ pdaJws: jws, resolveVerifyKey: async () => keys.publicKey, now })
    ).rejects.toMatchObject({ reason: "schema-invalid" });
  });
});
