/**
 * §17.1 A2A JWT normative profile — unit tests for W3 slice 1.
 *
 * Covers:
 *   - alg allowlist (SV-A2A-10 anchor)
 *   - claim presence + shape + audience + lifetime + expiry (SV-A2A-02)
 *   - jti replay cache (SV-A2A-12)
 *   - signing-key discovery outcomes (SV-A2A-11 foundation; slice 2 adds
 *     Agent-Card-fetch and mTLS paths)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import {
  A2A_JWT_ALLOWED_ALGS,
  A2A_JWT_MAX_LIFETIME_S,
  A2A_JWT_JTI_RETENTION_EXTRA_S,
  JtiReplayCache,
  verifyA2aJwt,
  type A2aJwtHeader,
  type A2aJwtKeyResolver,
  type A2aJwtVerifyKey,
} from "../src/a2a/jwt.js";

const AUD = "https://callee.test.local";
const ISS = "test-caller-agent";
const SUB = "https://caller.test.local";
const KID = "caller-ed25519-kid";

async function makeFreshKeyPair(): Promise<{
  publicKey: A2aJwtVerifyKey;
  privateKey: Parameters<typeof SignJWT.prototype.sign>[0];
}> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { publicKey: publicKey as unknown as A2aJwtVerifyKey, privateKey };
}

interface BuildJwtOpts {
  privateKey: Parameters<typeof SignJWT.prototype.sign>[0];
  nowS: number;
  lifetimeS?: number;
  override?: Partial<{
    aud: string;
    iss: string;
    sub: string;
    jti: string;
    iat: number;
    exp: number;
    agent_card_etag: string | null;
    alg: string;
    kid: string;
  }>;
}

async function buildJwt(opts: BuildJwtOpts): Promise<string> {
  const lifetime = opts.lifetimeS ?? 60;
  const payload: Record<string, unknown> = {
    iss: opts.override?.iss ?? ISS,
    sub: opts.override?.sub ?? SUB,
    aud: opts.override?.aud ?? AUD,
    iat: opts.override?.iat ?? opts.nowS,
    exp: opts.override?.exp ?? opts.nowS + lifetime,
    jti: opts.override?.jti ?? `jti-${Math.random().toString(36).slice(2, 14)}`,
    agent_card_etag:
      opts.override?.agent_card_etag === null
        ? undefined
        : (opts.override?.agent_card_etag ?? '"test-etag"'),
  };
  // Strip undefined agent_card_etag for the null-override case.
  if (payload.agent_card_etag === undefined) delete payload.agent_card_etag;

  return await new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({
      alg: opts.override?.alg ?? "EdDSA",
      kid: opts.override?.kid ?? KID,
    })
    .sign(opts.privateKey);
}

describe("JtiReplayCache (§17.1 step 3)", () => {
  it("register + has round-trip within retention window", () => {
    let now = 1000;
    const cache = new JtiReplayCache(() => now);
    cache.register("j1", 1100);
    expect(cache.has("j1")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it("prunes entries at exp + 30s retention boundary", () => {
    let now = 1000;
    const cache = new JtiReplayCache(() => now);
    cache.register("j1", 1100); // retainUntil = 1130
    now = 1129;
    expect(cache.has("j1")).toBe(true);
    now = 1130;
    expect(cache.has("j1")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("retainUntil formula is exactly exp + A2A_JWT_JTI_RETENTION_EXTRA_S", () => {
    expect(A2A_JWT_JTI_RETENTION_EXTRA_S).toBe(30);
    let now = 1000;
    const cache = new JtiReplayCache(() => now);
    const exp = 1500;
    cache.register("j1", exp);
    now = exp + A2A_JWT_JTI_RETENTION_EXTRA_S - 1;
    expect(cache.has("j1")).toBe(true);
    now = exp + A2A_JWT_JTI_RETENTION_EXTRA_S;
    expect(cache.has("j1")).toBe(false);
  });
});

describe("verifyA2aJwt (§17.1 steps 1 + 2 + 3)", () => {
  let publicKey: A2aJwtVerifyKey;
  let privateKey: Parameters<typeof SignJWT.prototype.sign>[0];
  let staticResolver: A2aJwtKeyResolver;
  const nowS = 1_800_000_000; // arbitrary stable time
  const nowFn = () => nowS;

  beforeAll(async () => {
    const pair = await makeFreshKeyPair();
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    staticResolver = async (header: A2aJwtHeader) => (header.kid === KID ? publicKey : null);
  });

  it("valid well-formed JWT passes", async () => {
    const jwt = await buildJwt({ privateKey, nowS });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("valid");
    if (out.kind === "valid") {
      expect(out.payload.aud).toBe(AUD);
      expect(out.header.alg).toBe("EdDSA");
      expect(out.header.kid).toBe(KID);
    }
  });

  it("alg outside allowlist → bad-alg", async () => {
    // Craft a JWT with unsupported alg=HS256. jose.SignJWT requires alg+key
    // compatibility; easier to splice: header.alg=HS256, signature bytes
    // won't verify but we flag bad-alg BEFORE signature check, so that's OK.
    const goodJwt = await buildJwt({ privateKey, nowS });
    const parts = goodJwt.split(".");
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: KID }),
      "utf8",
    ).toString("base64url");
    const spoofed = `${forgedHeader}.${parts[1]}.${parts[2]}`;
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: spoofed,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("bad-alg");
  });

  it("all §17.1 allowlist algs are recognized", () => {
    expect(A2A_JWT_ALLOWED_ALGS).toEqual(["EdDSA", "ES256", "RS256"]);
  });

  it("missing required claim → auth-failed", async () => {
    // Craft a JWT missing agent_card_etag.
    const jwt = await buildJwt({
      privateKey,
      nowS,
      override: { agent_card_etag: null },
    });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("auth-failed");
    if (out.kind === "auth-failed") expect(out.detail).toContain("agent_card_etag");
  });

  it("lifetime > 300s → auth-failed", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS,
      lifetimeS: A2A_JWT_MAX_LIFETIME_S + 1,
    });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("auth-failed");
    if (out.kind === "auth-failed") expect(out.detail).toContain("exceeds");
  });

  it("expired JWT → auth-failed", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS: nowS - 1000,
      lifetimeS: 100, // exp = nowS - 900, already past
    });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("auth-failed");
    if (out.kind === "auth-failed") expect(out.detail).toContain("expired");
  });

  it("iat in the future beyond clock skew → auth-failed", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS,
      override: { iat: nowS + 300, exp: nowS + 400 },
    });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
      clockSkewS: 60,
    });
    expect(out.kind).toBe("auth-failed");
    if (out.kind === "auth-failed") expect(out.detail).toContain("future");
  });

  it("aud mismatch → auth-failed", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS,
      override: { aud: "https://wrong.test.local" },
    });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("auth-failed");
    if (out.kind === "auth-failed") expect(out.detail).toContain("aud");
  });

  it("replayed jti → jti-replay on second verify", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS,
      override: { jti: "stable-jti-1" },
    });
    const cache = new JtiReplayCache(nowFn);
    const first = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(first.kind).toBe("valid");
    const second = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(second.kind).toBe("jti-replay");
  });

  it("signing-key not resolvable → key-not-found", async () => {
    const jwt = await buildJwt({ privateKey, nowS, override: { kid: "unknown-kid" } });
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("key-not-found");
  });

  it("tampered signature → signature-invalid (not jti-replay poisoning)", async () => {
    const jwt = await buildJwt({
      privateKey,
      nowS,
      override: { jti: "signature-invalid-jti" },
    });
    const parts = jwt.split(".");
    // Flip the last signature byte.
    const sigBytes = Buffer.from(parts[2]!, "base64url");
    sigBytes[sigBytes.length - 1] ^= 0x01;
    const tampered = `${parts[0]}.${parts[1]}.${sigBytes.toString("base64url")}`;

    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: tampered,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("signature-invalid");
    // Critical: tampered JWT MUST NOT have poisoned the replay cache, so a
    // subsequent legit JWT with the same jti can still pass.
    const legit = await buildJwt({
      privateKey,
      nowS,
      override: { jti: "signature-invalid-jti" },
    });
    const legitOut = await verifyA2aJwt({
      jwtCompact: legit,
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(legitOut.kind).toBe("valid");
  });

  it("non-3-segment JWT → auth-failed", async () => {
    const cache = new JtiReplayCache(nowFn);
    const out = await verifyA2aJwt({
      jwtCompact: "only.two",
      audience: AUD,
      resolveKey: staticResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("auth-failed");
  });

  it("resolver that throws → key-not-found (not uncaught)", async () => {
    const jwt = await buildJwt({ privateKey, nowS });
    const cache = new JtiReplayCache(nowFn);
    const throwingResolver: A2aJwtKeyResolver = async () => {
      throw new Error("boom");
    };
    const out = await verifyA2aJwt({
      jwtCompact: jwt,
      audience: AUD,
      resolveKey: throwingResolver,
      jtiCache: cache,
      nowFn,
    });
    expect(out.kind).toBe("key-not-found");
    if (out.kind === "key-not-found") expect(out.detail).toContain("boom");
  });
});
