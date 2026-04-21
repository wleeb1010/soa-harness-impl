import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jcsBytes } from "@soa-harness/core";
import {
  loadAndVerifyExternalCardJws,
  CardSignatureFailed,
  signAgentCard,
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  type TrustAnchor
} from "../src/card/index.js";
import { webcrypto } from "node:crypto";
import { X509Certificate } from "@peculiar/x509";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "..", "..", "..", "soa-harness=specification");
const TAMPERED_JWS_PATH = join(SPEC, "test-vectors", "tampered-card", "agent-card.json.tampered.jws");

function withTmp(body: string): { path: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "ext-jws-"));
  const path = join(dir, "external.jws");
  writeFileSync(path, body);
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function spkiHex(derB64: string): Promise<string> {
  const cert = new X509Certificate(Buffer.from(derB64, "base64"));
  const h = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(h).toString("hex");
}

const DEMO_CARD = {
  soaHarnessVersion: "1.0",
  name: "external-jws-test",
  version: "1.0.0",
  url: "https://runner.test.local",
  protocolVersion: "a2a-0.3",
  agentType: "general-purpose",
  permissions: { activeMode: "ReadOnly", handler: "Interactive" },
  security: { oauthScopes: [], trustAnchors: [] }
};

describe("T-06 — RUNNER_CARD_JWS loader (loadAndVerifyExternalCardJws)", () => {
  it("tampered fixture → CardSignatureFailed (boot refuses)", async () => {
    // The spec's tampered fixture is an all-zeros signature detached JWS
    // over test-vectors/agent-card.json. Feed it through our verifier
    // against any card body — verification MUST fail. Exact reason varies
    // (the spec fixture's protected header lacks x5c, so x5c-missing fires
    // before signature-invalid); the conformance guarantee the validator
    // checks is that the verifier rejects, which our test asserts.
    await expect(
      loadAndVerifyExternalCardJws({
        jwsPath: TAMPERED_JWS_PATH,
        canonicalBody: jcsBytes(DEMO_CARD),
        trustAnchors: []
      })
    ).rejects.toBeInstanceOf(CardSignatureFailed);
  });

  it("structurally-invalid JWS (too many segments) → detached-jws-malformed", async () => {
    const tmp = withTmp("too.many.dot.segments.here");
    try {
      await expect(
        loadAndVerifyExternalCardJws({
          jwsPath: tmp.path,
          canonicalBody: jcsBytes(DEMO_CARD),
          trustAnchors: []
        })
      ).rejects.toMatchObject({ reason: "detached-jws-malformed" });
    } finally {
      tmp.dispose();
    }
  });

  it("missing file → detached-jws-malformed with a clear pointer", async () => {
    await expect(
      loadAndVerifyExternalCardJws({
        jwsPath: "/nonexistent/external.jws",
        canonicalBody: jcsBytes(DEMO_CARD),
        trustAnchors: []
      })
    ).rejects.toMatchObject({ reason: "detached-jws-malformed" });
  });

  it("happy regression — a JWS we just signed with our own key, with matching anchor, passes", async () => {
    const keys = await generateEd25519KeyPair();
    const certDer = await generateSelfSignedEd25519Cert({ keys, subject: "CN=ext-test" });
    const card = { ...DEMO_CARD };
    const signed = await signAgentCard({
      card,
      alg: "EdDSA",
      kid: "soa-release-v1.0",
      privateKey: keys.privateKey,
      x5c: [certDer]
    });
    const anchor: TrustAnchor = {
      issuer: "CN=ext-test",
      spki_sha256: await spkiHex(certDer),
      uri: "https://ca.test.local/"
    };
    const tmp = withTmp(signed.detachedJws);
    try {
      const result = await loadAndVerifyExternalCardJws({
        jwsPath: tmp.path,
        canonicalBody: signed.canonicalBody,
        trustAnchors: [anchor]
      });
      expect(result.verified.matchedAnchor.spki_sha256).toBe(anchor.spki_sha256);
    } finally {
      tmp.dispose();
    }
  });
});
