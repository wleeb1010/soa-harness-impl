import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, compactVerify, flattenedVerify, type CryptoKey, type KeyObject } from "jose";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRunnerApp } from "../src/server.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD_FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST_FIXTURE = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8")
) as InitialTrust;

async function newApp(card = CARD_FIXTURE) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const kid = "soa-release-v1.0";
  const app = await buildRunnerApp({
    trust: TRUST_FIXTURE,
    card,
    alg: "EdDSA",
    kid,
    privateKey
  });
  return { app, publicKey, privateKey, kid };
}

describe("Agent Card endpoint", () => {
  let ctx: Awaited<ReturnType<typeof newApp>>;

  beforeAll(async () => {
    ctx = await newApp();
  });

  it("serves /.well-known/agent-card.json with the expected shape", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("max-age=300");
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("test-runner-agent");
    expect(body.protocolVersion).toBe("a2a-0.3");
  });

  it("serves the detached JWS at /.well-known/agent-card.json.jws", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json.jws" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/jose");
    const jws = res.body;
    // RFC 7515 Appendix F detached form: "h..s" — payload segment empty
    const segments = jws.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[1]).toBe("");
  });

  it("JSON and JWS responses share the same ETag (same signed body)", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const jwsRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json.jws" });
    expect(jsonRes.headers["etag"]).toBe(jwsRes.headers["etag"]);
  });

  it("honors If-None-Match with a 304 when the ETag matches", async () => {
    const first = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const etag = first.headers["etag"] as string;
    const second = await ctx.app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
      headers: { "if-none-match": etag }
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
    expect(second.body).toBe("");
  });

  it("produces a JWS that verifies against the signing key (reattached payload)", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const jwsRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json.jws" });
    const [protectedHeader, , signature] = jwsRes.body.split(".");
    const payloadB64 = Buffer.from(jsonRes.rawPayload).toString("base64url");
    const result = await flattenedVerify(
      { protected: protectedHeader, payload: payloadB64, signature },
      ctx.publicKey as CryptoKey | KeyObject
    );
    expect(result.protectedHeader.alg).toBe("EdDSA");
    expect(result.protectedHeader.kid).toBe("soa-release-v1.0");
    expect(result.protectedHeader.typ).toBe("soa-card+jws");
  });

  it("ETag changes when the card content changes", async () => {
    const first = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const mutated = { ...CARD_FIXTURE, name: "different-agent" };
    const ctx2 = await newApp(mutated);
    try {
      const second = await ctx2.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
      expect(second.headers["etag"]).not.toBe(first.headers["etag"]);
    } finally {
      await ctx2.app.close();
    }
  });

  it("non-detached compact form (reassembled) also verifies", async () => {
    const jsonRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const jwsRes = await ctx.app.inject({ method: "GET", url: "/.well-known/agent-card.json.jws" });
    const [h, , s] = jwsRes.body.split(".");
    const payloadB64 = Buffer.from(jsonRes.rawPayload).toString("base64url");
    const reassembled = `${h}.${payloadB64}.${s}`;
    const result = await compactVerify(reassembled, ctx.publicKey as CryptoKey | KeyObject);
    expect(result.protectedHeader.alg).toBe("EdDSA");
  });
});
