import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
      // Pass expectedDigest explicitly to isolate the digest-mismatch branch
      // (the tmp path isn't under a spec repo, so auto-lookup would trip
      // manifest-missing first). We pass the UNTAMPERED fixture's digest
      // so the assertion is "tampered bytes ≠ pinned digest".
      await expect(
        loadConformanceCard({
          fixturePath: tmp.path,
          leafCertDerBase64: cert,
          expectedDigest: PINNED_CONFORMANCE_CARD_DIGEST
        })
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

describe("loadConformanceCard — L-30 dynamic MANIFEST lookup", () => {
  const SPEC_ROOT = join(here, "..", "..", "..", "..", "soa-harness=specification");
  const V1_0_FIXTURE = join(SPEC_ROOT, "test-vectors", "conformance-card", "agent-card.json");
  const V1_1_FIXTURE = join(SPEC_ROOT, "test-vectors", "conformance-card-v1_1", "agent-card.json");

  it("v1.0 path auto-resolves its MANIFEST digest and loads clean", async () => {
    const cert = await signingCertB64();
    const result = await loadConformanceCard({
      fixturePath: V1_0_FIXTURE,
      leafCertDerBase64: cert
    });
    expect(result.manifestPath).toBe("test-vectors/conformance-card/agent-card.json");
    expect(result.fixtureDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("v1.1 path auto-resolves its MANIFEST digest and loads clean", async () => {
    const cert = await signingCertB64();
    const result = await loadConformanceCard({
      fixturePath: V1_1_FIXTURE,
      leafCertDerBase64: cert
    });
    expect(result.manifestPath).toBe("test-vectors/conformance-card-v1_1/agent-card.json");
    expect(result.fixtureDigest).toMatch(/^[0-9a-f]{64}$/);
    // v1.1 fixture should differ from v1.0 by the version field; confirm the
    // loader returned the v1.1 shape.
    expect((result.card as { version?: unknown }).version).toBe("1.1.0");
  });

  it("cross-swap attack: v1.0 bytes at the v1.1 path → digest-mismatch", async () => {
    // Copy v1.0 fixture bytes into a tmp directory structured to look like
    // the v1.1 path relative to the pinned spec root. Then pass explicit
    // specRoot so the MANIFEST lookup finds the v1.1 entry; the computed
    // digest (v1.0 bytes) won't match v1.1's pinned digest.
    const v1Bytes = readFileSync(V1_0_FIXTURE, "utf8");
    const fakeSpecRoot = mkdtempSync(join(tmpdir(), "cross-swap-"));
    const fakeV11Path = join(
      fakeSpecRoot,
      "test-vectors",
      "conformance-card-v1_1",
      "agent-card.json"
    );
    try {
      // Copy the real MANIFEST into the fake spec root so lookup works.
      writeFileSync(
        join(fakeSpecRoot, "MANIFEST.json"),
        readFileSync(join(SPEC_ROOT, "MANIFEST.json"), "utf8")
      );
      // Place v1.0 bytes at the v1.1 path.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(fakeSpecRoot, "test-vectors", "conformance-card-v1_1"), { recursive: true });
      writeFileSync(fakeV11Path, v1Bytes);
      const cert = await signingCertB64();
      await expect(
        loadConformanceCard({
          fixturePath: fakeV11Path,
          leafCertDerBase64: cert,
          specRoot: fakeSpecRoot
        })
      ).rejects.toMatchObject({ reason: "digest-mismatch" });
    } finally {
      rmSync(fakeSpecRoot, { recursive: true, force: true });
    }
  });

  it("path not in MANIFEST: throws manifest-path-not-found", async () => {
    const cert = await signingCertB64();
    const parsed = JSON.parse(readFileSync(V1_0_FIXTURE, "utf8"));
    // Put a fixture at an arbitrary path the real MANIFEST doesn't have an
    // entry for. Use the real spec root so MANIFEST.json is found, but the
    // fixture path is unknown.
    const tmp = mkdtempSync(join(tmpdir(), "unknown-path-"));
    const unlistedPath = join(tmp, "unlisted-agent-card.json");
    writeFileSync(unlistedPath, JSON.stringify(parsed));
    try {
      await expect(
        loadConformanceCard({
          fixturePath: unlistedPath,
          leafCertDerBase64: cert,
          specRoot: SPEC_ROOT
        })
      ).rejects.toMatchObject({ reason: "manifest-path-not-found" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no MANIFEST.json reachable: throws manifest-missing", async () => {
    const cert = await signingCertB64();
    const parsed = JSON.parse(readFileSync(V1_0_FIXTURE, "utf8"));
    // Auto-detect walks up 8 levels looking for MANIFEST.json. On Unix
    // tmpdir is shallow (`/tmp`) so it escapes to `/` quickly; on
    // Windows tmpdir is nested (`C:\Users\<user>\AppData\Local\Temp`)
    // and the walk can escape into user dirs where a stray MANIFEST
    // from another process can break the "no MANIFEST reachable"
    // premise. Build a 9-level-deep fixture path so the walk
    // exhausts its maxDepth budget before leaving the scratch tree,
    // regardless of the platform's tmpdir depth.
    const tmp = mkdtempSync(join(tmpdir(), "no-manifest-"));
    const deep = join(tmp, "a", "b", "c", "d", "e", "f", "g", "h", "i");
    mkdirSync(deep, { recursive: true });
    const fixturePath = join(deep, "agent-card.json");
    writeFileSync(fixturePath, JSON.stringify(parsed));
    try {
      await expect(
        loadConformanceCard({ fixturePath, leafCertDerBase64: cert })
      ).rejects.toMatchObject({ reason: "manifest-missing" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("expectedDigest escape hatch bypasses MANIFEST lookup (back-compat path)", async () => {
    // Back-compat: operators or tests passing expectedDigest explicitly
    // MUST skip the MANIFEST lookup entirely. Verify by placing the fixture
    // in a tmp dir with no MANIFEST + passing the real pinned digest.
    const cert = await signingCertB64();
    const parsed = JSON.parse(readFileSync(V1_0_FIXTURE, "utf8"));
    const tmp = mkdtempSync(join(tmpdir(), "explicit-digest-"));
    const fixturePath = join(tmp, "agent-card.json");
    writeFileSync(fixturePath, JSON.stringify(parsed));
    try {
      const canonical = jcs(parsed);
      const expected = sha256Hex(Buffer.from(canonical, "utf8"));
      const result = await loadConformanceCard({
        fixturePath,
        leafCertDerBase64: cert,
        expectedDigest: expected
      });
      expect(result.manifestPath).toBeUndefined(); // no MANIFEST consulted
      expect(result.fixtureDigest).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
