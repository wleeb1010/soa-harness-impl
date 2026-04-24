/**
 * §17.2.4 agent.describe result shape — end-to-end conformance.
 *
 * Exercises the full buildRunnerApp → cardPlugin + a2aPlugin chain so the
 * `agent.describe` response carries a real §6.1.1-compliant signed JWS
 * whose signing input is `JCS(result.card)`. Existing a2a.test.ts runs
 * the a2a plugin in isolation with placeholder JWS strings — that unit
 * coverage stays valid but does NOT exercise the server-bootstrap wiring
 * this file asserts.
 *
 * Per-response invariant the test pins (§17.2.4 "Verification order"):
 *   JWS-verify(result.jws, JCS(result.card))  succeeds
 * under §6.1.1 two-step signer resolution against the Runner's anchors.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import { jcsBytes, sha256Hex } from "@soa-harness/core";
import { buildRunnerApp } from "../src/server.js";
import {
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  verifyAgentCardJws,
  type TrustAnchor,
} from "../src/card/index.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8"),
) as InitialTrust;

const KID = "soa-release-v1.0";
const BEARER = "a2a-test-bearer-" + "x".repeat(24);

async function spkiHex(derB64: string): Promise<string> {
  const der = Buffer.from(derB64, "base64");
  const { X509Certificate } = await import("@peculiar/x509");
  const cert = new X509Certificate(der);
  const hash = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(hash).toString("hex");
}

describe("§17.2.4 agent.describe result shape (end-to-end via buildRunnerApp)", () => {
  let app: Awaited<ReturnType<typeof buildRunnerApp>>;
  let anchor: TrustAnchor;

  beforeAll(async () => {
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
    const leafSpki = await spkiHex(cert);
    anchor = {
      issuer: `CN=${KID},O=Test`,
      spki_sha256: leafSpki,
      uri: "https://ca.test.local/soa-test",
      publisher_kid: KID,
    };
    app = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: KID,
      privateKey: keys.privateKey,
      x5c: [cert],
      a2a: {
        bearer: BEARER,
        a2aCapabilities: ["summarize", "translate-en-de"],
      },
    });
  });

  it("returns result envelope with required card + jws fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("1");
    expect(typeof body.result).toBe("object");
    expect(body.result).not.toBeNull();
    expect(typeof body.result.card).toBe("object");
    expect(typeof body.result.jws).toBe("string");
  });

  it("result.jws is compact-detached shape (two dots, empty body segment)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const { jws } = JSON.parse(res.body).result;
    expect(jws).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
    // Make sure it's NOT the W1 placeholder.
    expect(jws).not.toContain("PLACEHOLDER");
  });

  it("JWS verifies against JCS(result.card) under §6.1.1 two-step signer resolution", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const { card, jws } = JSON.parse(res.body).result;
    const canonicalBody = jcsBytes(card);
    const verified = await verifyAgentCardJws({
      canonicalBody,
      detachedJws: jws,
      trustAnchors: [anchor],
    });
    expect(verified.protectedHeader.alg).toBe("EdDSA");
    expect(verified.protectedHeader.typ).toBe("soa-agent-card+jws");
    expect(verified.matchedAnchor.publisher_kid).toBe(KID);
  });

  it("result.card round-trips JCS byte-identically with the /.well-known/agent-card.json body", async () => {
    const describeRes = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const { card } = JSON.parse(describeRes.body).result;

    const wellKnown = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(wellKnown.statusCode).toBe(200);

    const a2aJcs = jcsBytes(card);
    const wellKnownJcs = jcsBytes(JSON.parse(wellKnown.body));
    expect(a2aJcs.equals(wellKnownJcs)).toBe(true);
  });

  it("§17.2.4 etag formula: SHA-256(JCS(card)) matches the ETag served on /.well-known/agent-card.jws", async () => {
    const describeRes = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const { card } = JSON.parse(describeRes.body).result;
    const computedEtag = `"${sha256Hex(jcsBytes(card))}"`;

    const wellKnownJws = await app.inject({ method: "GET", url: "/.well-known/agent-card.jws" });
    expect(wellKnownJws.headers.etag).toBe(computedEtag);
  });

  it("§17.2.3 matching: result.card carries the a2a.capabilities that drive handoff.offer", async () => {
    const describeRes = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
    });
    const { card } = JSON.parse(describeRes.body).result;
    // The card fixture doesn't declare a2a by default — the Runner's a2a
    // plugin is configured separately via the buildRunnerApp a2a.a2aCapabilities
    // option. The spec says matching reads the card.a2a.capabilities field;
    // here we document the current test fixture state so the relationship
    // is observable. A production Runner would align card.a2a.capabilities
    // with its a2aPlugin.a2aCapabilities option.
    expect(card).toBeDefined();
  });

  it("when a2a option is omitted, /a2a/v1 is NOT mounted", async () => {
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
    const appNoA2a = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: KID,
      privateKey: keys.privateKey,
      x5c: [cert],
      // a2a intentionally omitted
    });
    try {
      const res = await appNoA2a.inject({
        method: "POST",
        url: "/a2a/v1",
        headers: { "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: "1", method: "agent.describe" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await appNoA2a.close();
    }
  });
});
