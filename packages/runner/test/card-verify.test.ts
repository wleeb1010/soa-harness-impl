import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { jcsBytes } from "@soa-harness/core";
import {
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  signAgentCard,
  verifyAgentCardJws,
  CardSignatureFailed,
  type TrustAnchor
} from "../src/card/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const KID = "soa-release-v1.0";

async function spkiHex(derB64: string): Promise<string> {
  const der = Buffer.from(derB64, "base64");
  const { X509Certificate } = await import("@peculiar/x509");
  const cert = new X509Certificate(der);
  const hash = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(hash).toString("hex");
}

interface SignedFixture {
  canonicalBody: Buffer;
  detachedJws: string;
  anchor: TrustAnchor;
  otherAnchor: TrustAnchor;
}

async function makeSignedFixture(card: unknown = CARD): Promise<SignedFixture> {
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
  const { canonicalBody, detachedJws } = await signAgentCard({
    card,
    alg: "EdDSA",
    kid: KID,
    privateKey: keys.privateKey,
    x5c: [cert]
  });

  const leafSpki = await spkiHex(cert);
  const anchor: TrustAnchor = {
    issuer: `CN=${KID},O=Test`,
    spki_sha256: leafSpki,
    uri: "https://ca.test.local/soa-test",
    publisher_kid: KID
  };
  const otherAnchor: TrustAnchor = {
    issuer: "CN=Other,O=Test",
    spki_sha256: "f".repeat(64),
    uri: "https://ca.other.local/soa-test"
  };

  return { canonicalBody, detachedJws, anchor, otherAnchor };
}

describe("verifyAgentCardJws", () => {
  let ok: SignedFixture;

  beforeAll(async () => {
    ok = await makeSignedFixture();
  });

  it("verifies a well-formed detached JWS against an SPKI-matching anchor", async () => {
    const result = await verifyAgentCardJws({
      canonicalBody: ok.canonicalBody,
      detachedJws: ok.detachedJws,
      trustAnchors: [ok.otherAnchor, ok.anchor]
    });
    expect(result.matchedAnchor.publisher_kid).toBe(KID);
    expect(result.protectedHeader.alg).toBe("EdDSA");
    expect(result.protectedHeader.typ).toBe("soa-agent-card+jws");
    expect(result.leafSpkiSha256).toBe(ok.anchor.spki_sha256);
  });

  it("rejects a JWS whose payload segment is non-empty (not detached form)", async () => {
    const [h, , s] = ok.detachedJws.split(".");
    const wrong = `${h}.payloadhere.${s}`;
    await expect(
      verifyAgentCardJws({ canonicalBody: ok.canonicalBody, detachedJws: wrong, trustAnchors: [ok.anchor] })
    ).rejects.toMatchObject({ reason: "detached-jws-malformed" });
  });

  it("rejects when the protected header typ is not soa-agent-card+jws", async () => {
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID}` });
    // Hand-build a JWS with a wrong typ
    const { CompactSign } = await import("jose");
    const canonical = jcsBytes(CARD);
    const compact = await new CompactSign(canonical)
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-pda+jws", x5c: [cert] })
      .sign(keys.privateKey);
    const [h, , s] = compact.split(".");
    const detached = `${h}..${s}`;
    const spki = await spkiHex(cert);
    const anchor: TrustAnchor = { issuer: "CN=Test", spki_sha256: spki, uri: "https://ca.test.local" };
    await expect(
      verifyAgentCardJws({ canonicalBody: canonical, detachedJws: detached, trustAnchors: [anchor] })
    ).rejects.toMatchObject({ reason: "typ-mismatch" });
  });

  it("rejects when the signature does not match the leaf cert", async () => {
    // Sign with one key, present x5c containing a different cert
    const signerKeys = await generateEd25519KeyPair();
    const decoyKeys = await generateEd25519KeyPair();
    const decoyCert = await generateSelfSignedEd25519Cert({ keys: decoyKeys, subject: `CN=${KID}-decoy` });
    const { CompactSign } = await import("jose");
    const canonical = jcsBytes(CARD);
    const compact = await new CompactSign(canonical)
      .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "soa-agent-card+jws", x5c: [decoyCert] })
      .sign(signerKeys.privateKey);
    const [h, , s] = compact.split(".");
    const detached = `${h}..${s}`;
    const spki = await spkiHex(decoyCert);
    const anchor: TrustAnchor = { issuer: "CN=Test", spki_sha256: spki, uri: "https://ca.test.local" };
    await expect(
      verifyAgentCardJws({ canonicalBody: canonical, detachedJws: detached, trustAnchors: [anchor] })
    ).rejects.toMatchObject({ reason: "signature-invalid" });
  });

  it("rejects when no cert in the chain SPKI-matches any anchor", async () => {
    await expect(
      verifyAgentCardJws({
        canonicalBody: ok.canonicalBody,
        detachedJws: ok.detachedJws,
        trustAnchors: [ok.otherAnchor]
      })
    ).rejects.toMatchObject({ reason: "chain-anchor-mismatch" });
  });

  it("rejects a tampered canonical body (signature over wrong bytes)", async () => {
    const tampered = Buffer.concat([ok.canonicalBody, Buffer.from(" ")]);
    await expect(
      verifyAgentCardJws({ canonicalBody: tampered, detachedJws: ok.detachedJws, trustAnchors: [ok.anchor] })
    ).rejects.toMatchObject({ reason: "signature-invalid" });
  });

  it("round-trips sign → verify against the module's own signAgentCard output", async () => {
    const fresh = await makeSignedFixture({ ...CARD, name: "round-trip-agent" });
    const result = await verifyAgentCardJws({
      canonicalBody: fresh.canonicalBody,
      detachedJws: fresh.detachedJws,
      trustAnchors: [fresh.anchor]
    });
    expect(result.matchedAnchor.spki_sha256).toBe(fresh.anchor.spki_sha256);
  });
});
