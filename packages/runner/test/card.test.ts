import { describe, it, expect, beforeAll } from "vitest";
import { compactVerify, flattenedVerify, type CryptoKey, type KeyObject } from "jose";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRunnerApp } from "../src/server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD_FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST_FIXTURE = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8")
) as InitialTrust;

const JSON_URL = "/.well-known/agent-card.json";
const JWS_URL = "/.well-known/agent-card.jws";
const KID = "soa-release-v1.0";

async function newApp(card = CARD_FIXTURE) {
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({
    keys,
    subject: `CN=${KID},O=Test`
  });
  const x5c = [cert];
  const app = await buildRunnerApp({
    trust: TRUST_FIXTURE,
    card,
    alg: "EdDSA",
    kid: KID,
    privateKey: keys.privateKey,
    x5c
  });
  return { app, publicKey: keys.publicKey, kid: KID, x5c };
}

describe("Agent Card endpoint", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeAll(async () => {
    ctx = await newApp();
  });

  it("serves /.well-known/agent-card.json with the expected shape", async () => {
    const res = await ctx.app.inject({ method: "GET", url: JSON_URL });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("max-age=300");
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("test-runner-agent");
    expect(body.protocolVersion).toBe("a2a-0.3");
  });

  it("serves the detached JWS at /.well-known/agent-card.jws (URL shorthand per §5.1)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: JWS_URL });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/jose");
    const jws = res.body;
    // RFC 7515 Appendix F detached form: "h..s" — payload segment empty
    const segments = jws.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[1]).toBe("");
  });

  it("JSON and JWS responses share the same ETag (same signed body)", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: JSON_URL });
    const jwsRes = await ctx.app.inject({ method: "GET", url: JWS_URL });
    expect(jsonRes.headers["etag"]).toBe(jwsRes.headers["etag"]);
  });

  it("honors If-None-Match with a 304 when the ETag matches", async () => {
    const first = await ctx.app.inject({ method: "GET", url: JSON_URL });
    const etag = first.headers["etag"] as string;
    const second = await ctx.app.inject({
      method: "GET",
      url: JSON_URL,
      headers: { "if-none-match": etag }
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
    expect(second.body).toBe("");
  });

  it("protected header carries alg + kid + x5c + typ per §6.1.1", async () => {
    const jwsRes = await ctx.app.inject({ method: "GET", url: JWS_URL });
    const [protectedB64] = jwsRes.body.split(".");
    const header = JSON.parse(Buffer.from(protectedB64, "base64url").toString("utf8"));
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(KID);
    expect(header.typ).toBe("soa-agent-card+jws");
    expect(Array.isArray(header.x5c)).toBe(true);
    expect(header.x5c).toHaveLength(1);
    expect(header.x5c[0]).toEqual(ctx.x5c[0]);
    // base64 DER — coarse shape check (no dashes, no spaces, decode-able)
    expect(() => Buffer.from(header.x5c[0], "base64")).not.toThrow();
  });

  it("produces a JWS that verifies against the signing key (reattached payload)", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: JSON_URL });
    const jwsRes = await ctx.app.inject({ method: "GET", url: JWS_URL });
    const [protectedHeader, , signature] = jwsRes.body.split(".");
    const payloadB64 = Buffer.from(jsonRes.rawPayload).toString("base64url");
    const result = await flattenedVerify(
      { protected: protectedHeader, payload: payloadB64, signature },
      ctx.publicKey as CryptoKey | KeyObject
    );
    expect(result.protectedHeader.alg).toBe("EdDSA");
    expect(result.protectedHeader.kid).toBe(KID);
    expect(result.protectedHeader.typ).toBe("soa-agent-card+jws");
  });

  it("ETag changes when the card content changes", async () => {
    const first = await ctx.app.inject({ method: "GET", url: JSON_URL });
    const mutated = { ...CARD_FIXTURE, name: "different-agent" };
    const ctx2 = await newApp(mutated);
    try {
      const second = await ctx2.app.inject({ method: "GET", url: JSON_URL });
      expect(second.headers["etag"]).not.toBe(first.headers["etag"]);
    } finally {
      await ctx2.app.close();
    }
  });

  it("non-detached compact form (reassembled) also verifies", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: JSON_URL });
    const jwsRes = await ctx.app.inject({ method: "GET", url: JWS_URL });
    const [h, , s] = jwsRes.body.split(".");
    const payloadB64 = Buffer.from(jsonRes.rawPayload).toString("base64url");
    const reassembled = `${h}.${payloadB64}.${s}`;
    const result = await compactVerify(reassembled, ctx.publicKey as CryptoKey | KeyObject);
    expect(result.protectedHeader.alg).toBe("EdDSA");
  });

  it("signer rejects an empty x5c", async () => {
    await expect(
      (async () => {
        const keys = await generateEd25519KeyPair();
        await buildRunnerApp({
          trust: TRUST_FIXTURE,
          card: CARD_FIXTURE,
          alg: "EdDSA",
          kid: KID,
          privateKey: keys.privateKey,
          x5c: []
        });
      })()
    ).rejects.toThrow(/x5c must be a non-empty array/);
  });
});
