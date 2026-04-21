import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fastify } from "fastify";
import { jcs, sha256Hex } from "@soa-harness/core";
import {
  loadConformanceCard,
  ConformanceFixtureTampered,
  PLACEHOLDER_SPKI,
  PINNED_CONFORMANCE_CARD_DIGEST,
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  cardPlugin
} from "../src/card/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// Reach into the pinned spec clone — sibling repo at ../../../../soa-harness=specification
const SPEC_FIXTURE = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "soa-harness=specification",
  "test-vectors",
  "conformance-card",
  "agent-card.json"
);

function writeTmpCard(body: unknown): { path: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "conf-card-"));
  const path = join(dir, "agent-card.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function signingCertB64(): Promise<string> {
  const keys = await generateEd25519KeyPair();
  return generateSelfSignedEd25519Cert({ keys, subject: "CN=test,O=Test" });
}

describe("loadConformanceCard — happy-path substitution", () => {
  it("loads the pinned fixture and substitutes the placeholder with runtime SPKI", async () => {
    const cert = await signingCertB64();
    const { card, substitutedSpki, fixtureDigest } = await loadConformanceCard({
      fixturePath: SPEC_FIXTURE,
      leafCertDerBase64: cert
    });
    expect(fixtureDigest).toBe(PINNED_CONFORMANCE_CARD_DIGEST);
    expect(substitutedSpki).toMatch(/^[0-9a-f]{64}$/);
    const anchors = (card["security"] as { trustAnchors: Array<{ spki_sha256: string }> }).trustAnchors;
    expect(anchors[0]?.spki_sha256).toBe(substitutedSpki);
    expect(anchors[0]?.spki_sha256).not.toBe(PLACEHOLDER_SPKI);
  });

  it("substitution is deterministic for a fixed signing cert", async () => {
    const cert = await signingCertB64();
    const a = await loadConformanceCard({ fixturePath: SPEC_FIXTURE, leafCertDerBase64: cert });
    const b = await loadConformanceCard({ fixturePath: SPEC_FIXTURE, leafCertDerBase64: cert });
    expect(a.substitutedSpki).toBe(b.substitutedSpki);
    expect(sha256Hex(jcs(a.card))).toBe(sha256Hex(jcs(b.card)));
  });
});

describe("loadConformanceCard — failure modes", () => {
  it("throws read-failure when the fixture file is absent", async () => {
    const cert = await signingCertB64();
    await expect(
      loadConformanceCard({ fixturePath: "/nonexistent/agent-card.json", leafCertDerBase64: cert })
    ).rejects.toMatchObject({ reason: "read-failure" });
  });

  it("throws digest-mismatch when any non-placeholder field is tampered", async () => {
    const cert = await signingCertB64();
    const parsed = JSON.parse(readFileSync(SPEC_FIXTURE, "utf8"));
    parsed.name = "tampered-name"; // mutate a non-placeholder field
    const tmp = writeTmpCard(parsed);
    try {
      await expect(
        loadConformanceCard({ fixturePath: tmp.path, leafCertDerBase64: cert })
      ).rejects.toMatchObject({ reason: "digest-mismatch" });
    } finally {
      tmp.dispose();
    }
  });

  it("throws missing-placeholder when the fixture no longer carries the sentinel", async () => {
    const cert = await signingCertB64();
    // Build a card that otherwise-validates but has no placeholder — signal that
    // the fixture was pre-substituted. We bypass the digest check by providing
    // a matching expectedDigest, so this test only exercises the placeholder check.
    const parsed = JSON.parse(readFileSync(SPEC_FIXTURE, "utf8"));
    parsed.security.trustAnchors[0].spki_sha256 = "0".repeat(64);
    const tmp = writeTmpCard(parsed);
    try {
      const canonical = jcs(parsed);
      const expected = sha256Hex(Buffer.from(canonical, "utf8"));
      await expect(
        loadConformanceCard({
          fixturePath: tmp.path,
          leafCertDerBase64: cert,
          expectedDigest: expected
        })
      ).rejects.toMatchObject({ reason: "missing-placeholder" });
    } finally {
      tmp.dispose();
    }
  });
});

describe("cardPlugin — skipSchemaValidation for conformance fixture", () => {
  it("serves a conformance card whose fields would fail agent-card.schema.json when opt is true", async () => {
    const cert = await signingCertB64();
    const { card } = await loadConformanceCard({ fixturePath: SPEC_FIXTURE, leafCertDerBase64: cert });
    const keys = await generateEd25519KeyPair();
    const leaf = await generateSelfSignedEd25519Cert({ keys, subject: "CN=conformance" });
    const app = fastify();
    await app.register(cardPlugin, {
      card,
      alg: "EdDSA",
      kid: "soa-conformance-test-release-v1.0",
      privateKey: keys.privateKey,
      x5c: [leaf],
      skipSchemaValidation: true
    });
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
