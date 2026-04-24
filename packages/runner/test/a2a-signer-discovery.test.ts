/**
 * §17.1 step 2 + step 4 — W3 slice 2 unit tests.
 *
 * Covers:
 *   - CallerCardCache TTL + lazy prune (60 s per §17.1).
 *   - computeAgentCardEtag formula (§17.2.4).
 *   - fetchCallerCard happy path + schema-invalid body + fetch-fail.
 *   - extractSignerFromCardJws for a well-formed Agent Card JWS.
 *   - buildCardKidResolver happy path, unreachable, kid mismatch.
 *   - checkAgentCardEtagDrift match / drift / unreachable.
 *   - buildPeerCertResolver x5t#S256 match, mismatch, missing.
 *   - composeSignerResolvers order + short-circuit.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import { jcsBytes, sha256Hex } from "@soa-harness/core";
import {
  A2A_CARD_CACHE_TTL_S,
  CallerCardCache,
  buildCardKidResolver,
  buildPeerCertResolver,
  checkAgentCardEtagDrift,
  composeSignerResolvers,
  computeAgentCardEtag,
  extractSignerFromCardJws,
  fetchCallerCard,
  loadCallerCard,
  type CallerCardFetcher,
  type FetchedCallerCard,
} from "../src/a2a/signer-discovery.js";
import {
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  signAgentCard,
} from "../src/card/index.js";
import type { A2aJwtHeader, A2aJwtKeyResolver, A2aJwtPayload } from "../src/a2a/jwt.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const KID = "caller-ed25519-kid";

interface SignedFixture {
  jws: string;
  etag: string;
  privateKey: Parameters<typeof signAgentCard>[0]["privateKey"];
  certDer: Buffer;
}

async function makeSignedCard(): Promise<SignedFixture> {
  const keys = await generateEd25519KeyPair();
  const certB64 = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
  const { detachedJws } = await signAgentCard({
    card: CARD,
    alg: "EdDSA",
    kid: KID,
    privateKey: keys.privateKey,
    x5c: [certB64],
  });
  return {
    jws: detachedJws,
    etag: computeAgentCardEtag(CARD),
    privateKey: keys.privateKey,
    certDer: Buffer.from(certB64, "base64"),
  };
}

describe("CallerCardCache (§17.1 step 2 + 4 cache)", () => {
  it("stores + retrieves a fetched card", () => {
    let now = 1000;
    const cache = new CallerCardCache(() => now);
    const entry: FetchedCallerCard = {
      card: { hello: "world" },
      jws: "<jws>",
      etag: '"abc"',
      cachedAt: now,
    };
    cache.set("https://a", entry);
    expect(cache.get("https://a")?.etag).toBe('"abc"');
  });

  it("prunes at 60s TTL boundary", () => {
    let now = 1000;
    const cache = new CallerCardCache(() => now);
    cache.set("https://a", { card: {}, jws: "", etag: '"x"', cachedAt: 1000 });
    now = 1000 + A2A_CARD_CACHE_TTL_S - 1;
    expect(cache.get("https://a")).not.toBeNull();
    now = 1000 + A2A_CARD_CACHE_TTL_S;
    expect(cache.get("https://a")).toBeNull();
  });
});

describe("computeAgentCardEtag (§17.2.4 formula)", () => {
  it("matches the normative formula `\"<hex SHA-256 of JCS>\"`", () => {
    const card = { a: 1, b: 2 };
    const expected = `"${sha256Hex(jcsBytes(card))}"`;
    expect(computeAgentCardEtag(card)).toBe(expected);
  });

  it("is deterministic under JCS re-keying", () => {
    expect(computeAgentCardEtag({ b: 2, a: 1 })).toBe(computeAgentCardEtag({ a: 1, b: 2 }));
  });
});

describe("fetchCallerCard", () => {
  it("returns null when card fetch returns non-2xx", async () => {
    const mockFetch = (async (url: string) => {
      if (url.endsWith("/agent-card.json")) return new Response(null, { status: 404 });
      return new Response("stub", { status: 200 });
    }) as unknown as typeof fetch;
    const fetched = await fetchCallerCard("https://caller.test.local", () => 1000, mockFetch);
    expect(fetched).toBeNull();
  });

  it("returns null when card body fails agent-card.schema.json", async () => {
    const mockFetch = (async (url: string) => {
      if (url.endsWith("/agent-card.json")) {
        return new Response(JSON.stringify({ wrong: "shape" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("stub-jws", { status: 200 });
    }) as unknown as typeof fetch;
    const fetched = await fetchCallerCard("https://caller.test.local", () => 1000, mockFetch);
    expect(fetched).toBeNull();
  });

  it("returns the bundled {card, jws, etag} on success", async () => {
    const mockFetch = (async (url: string) => {
      if (url.endsWith("/agent-card.json")) {
        return new Response(JSON.stringify(CARD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("header..sig", {
        status: 200,
        headers: { "content-type": "application/jose" },
      });
    }) as unknown as typeof fetch;
    const fetched = await fetchCallerCard("https://caller.test.local", () => 42, mockFetch);
    expect(fetched).not.toBeNull();
    expect(fetched?.etag).toBe(computeAgentCardEtag(CARD));
    expect(fetched?.jws).toBe("header..sig");
    expect(fetched?.cachedAt).toBe(42);
  });

  it("returns null when fetch throws (simulated network error)", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const fetched = await fetchCallerCard("https://caller.test.local", () => 1000, mockFetch);
    expect(fetched).toBeNull();
  });
});

describe("extractSignerFromCardJws", () => {
  let fixture: SignedFixture;
  beforeAll(async () => {
    fixture = await makeSignedCard();
  });

  it("returns a jose KeyLike for a well-formed Agent Card JWS", async () => {
    const key = await extractSignerFromCardJws(fixture.jws);
    expect(key).not.toBeNull();
  });

  it("returns null for a 2-segment JWS (wrong shape)", async () => {
    const key = await extractSignerFromCardJws("only.two");
    expect(key).toBeNull();
  });

  it("returns null when x5c is missing", async () => {
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA" }), "utf8").toString("base64url");
    const key = await extractSignerFromCardJws(`${forgedHeader}..${"sig"}`);
    expect(key).toBeNull();
  });

  it("returns null when alg is outside the allowlist", async () => {
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", x5c: ["stub"] }),
      "utf8",
    ).toString("base64url");
    const key = await extractSignerFromCardJws(`${forgedHeader}..${"sig"}`);
    expect(key).toBeNull();
  });
});

describe("buildCardKidResolver (§17.1 step 2 — Agent-Card-kid path)", () => {
  let fixture: SignedFixture;
  let fetcher: CallerCardFetcher;

  beforeAll(async () => {
    fixture = await makeSignedCard();
    fetcher = async () => ({
      card: CARD,
      jws: fixture.jws,
      etag: fixture.etag,
      cachedAt: 1000,
    });
  });

  const mockPayload: A2aJwtPayload = {
    iss: "caller",
    sub: "https://caller.test.local",
    aud: "https://callee.test.local",
    iat: 0,
    exp: 1,
    jti: "j",
    agent_card_etag: '"x"',
  };

  it("happy path: returns the public key from card.jws x5c[0]", async () => {
    const cache = new CallerCardCache(() => 1000);
    const resolve = buildCardKidResolver(cache, fetcher);
    const key = await resolve({ alg: "EdDSA", kid: KID }, mockPayload);
    expect(key).not.toBeNull();
  });

  it("returns null when card fetch returns null (card-unreachable)", async () => {
    const cache = new CallerCardCache(() => 1000);
    const unreachableFetcher: CallerCardFetcher = async () => null;
    const resolve = buildCardKidResolver(cache, unreachableFetcher);
    const key = await resolve({ alg: "EdDSA", kid: KID }, mockPayload);
    expect(key).toBeNull();
  });

  it("returns null when JWT kid does not match Agent Card JWS kid", async () => {
    const cache = new CallerCardCache(() => 1000);
    const resolve = buildCardKidResolver(cache, fetcher);
    const key = await resolve({ alg: "EdDSA", kid: "different-kid" }, mockPayload);
    expect(key).toBeNull();
  });

  it("caches the fetched card for subsequent calls (single fetch per window)", async () => {
    const cache = new CallerCardCache(() => 1000);
    let fetchCount = 0;
    const countingFetcher: CallerCardFetcher = async () => {
      fetchCount += 1;
      return { card: CARD, jws: fixture.jws, etag: fixture.etag, cachedAt: 1000 };
    };
    const resolve = buildCardKidResolver(cache, countingFetcher);
    await resolve({ alg: "EdDSA", kid: KID }, mockPayload);
    await resolve({ alg: "EdDSA", kid: KID }, mockPayload);
    await resolve({ alg: "EdDSA", kid: KID }, mockPayload);
    expect(fetchCount).toBe(1);
  });
});

describe("checkAgentCardEtagDrift (§17.1 step 4)", () => {
  const mockFetched = (etag: string): FetchedCallerCard => ({
    card: CARD,
    jws: "<jws>",
    etag,
    cachedAt: 1000,
  });

  it("match → {kind:'match'}", async () => {
    const cache = new CallerCardCache(() => 1000);
    const presented = '"abc123"';
    const outcome = await checkAgentCardEtagDrift({
      subUrl: "https://a",
      presentedEtag: presented,
      cache,
      fetcher: async () => mockFetched(presented),
    });
    expect(outcome.kind).toBe("match");
  });

  it("drift → {kind:'drift', fetched, presented}", async () => {
    const cache = new CallerCardCache(() => 1000);
    const outcome = await checkAgentCardEtagDrift({
      subUrl: "https://a",
      presentedEtag: '"stale"',
      cache,
      fetcher: async () => mockFetched('"fresh"'),
    });
    expect(outcome.kind).toBe("drift");
    if (outcome.kind === "drift") {
      expect(outcome.fetched).toBe('"fresh"');
      expect(outcome.presented).toBe('"stale"');
    }
  });

  it("card-unreachable when fetcher returns null", async () => {
    const cache = new CallerCardCache(() => 1000);
    const outcome = await checkAgentCardEtagDrift({
      subUrl: "https://a",
      presentedEtag: '"x"',
      cache,
      fetcher: async () => null,
    });
    expect(outcome.kind).toBe("card-unreachable");
  });
});

describe("buildPeerCertResolver (§17.1 step 2 — mTLS path)", () => {
  let fixture: SignedFixture;
  beforeAll(async () => {
    fixture = await makeSignedCard();
  });

  const mockPayload: A2aJwtPayload = {
    iss: "caller",
    sub: "https://caller.test.local",
    aud: "https://callee.test.local",
    iat: 0,
    exp: 1,
    jti: "j",
    agent_card_etag: '"x"',
  };

  it("resolves when header x5t#S256 matches SHA-256(peer cert DER)", async () => {
    const resolver = buildPeerCertResolver();
    const thumbprint = sha256Hex(fixture.certDer);
    const x5t = Buffer.from(thumbprint, "hex").toString("base64url");
    const key = await resolver(
      { alg: "EdDSA", "x5t#S256": x5t },
      mockPayload,
      { peerCertDer: fixture.certDer },
    );
    expect(key).not.toBeNull();
  });

  it("returns null when header x5t#S256 is missing", async () => {
    const resolver = buildPeerCertResolver();
    const key = await resolver({ alg: "EdDSA" }, mockPayload, { peerCertDer: fixture.certDer });
    expect(key).toBeNull();
  });

  it("returns null when peer cert is not provided", async () => {
    const resolver = buildPeerCertResolver();
    const key = await resolver(
      { alg: "EdDSA", "x5t#S256": "AAAA" },
      mockPayload,
      {},
    );
    expect(key).toBeNull();
  });

  it("returns null when thumbprint mismatches", async () => {
    const resolver = buildPeerCertResolver();
    const wrongX5t = Buffer.from("0".repeat(64), "hex").toString("base64url");
    const key = await resolver(
      { alg: "EdDSA", "x5t#S256": wrongX5t },
      mockPayload,
      { peerCertDer: fixture.certDer },
    );
    expect(key).toBeNull();
  });
});

describe("composeSignerResolvers", () => {
  const mockPayload: A2aJwtPayload = {
    iss: "caller",
    sub: "https://caller.test.local",
    aud: "https://callee.test.local",
    iat: 0,
    exp: 1,
    jti: "j",
    agent_card_etag: '"x"',
  };

  it("tries each resolver in order and returns the first non-null result", async () => {
    const called: number[] = [];
    const one: A2aJwtKeyResolver = async () => {
      called.push(1);
      return null;
    };
    const two: A2aJwtKeyResolver = async () => {
      called.push(2);
      return {} as unknown as ReturnType<typeof Buffer.alloc>;
    };
    const three: A2aJwtKeyResolver = async () => {
      called.push(3);
      return null;
    };
    const composite = composeSignerResolvers(one, two, three);
    const key = await composite({ alg: "EdDSA" }, mockPayload);
    expect(key).not.toBeNull();
    expect(called).toEqual([1, 2]); // short-circuits after 2 succeeds
  });

  it("returns null when every resolver returns null", async () => {
    const always: A2aJwtKeyResolver = async () => null;
    const composite = composeSignerResolvers(always, always);
    const key = await composite({ alg: "EdDSA" }, mockPayload);
    expect(key).toBeNull();
  });
});

describe("loadCallerCard (cache + fetcher integration)", () => {
  it("hits the cache on second call", async () => {
    const cache = new CallerCardCache(() => 1000);
    let fetchCount = 0;
    const fetcher: CallerCardFetcher = async () => {
      fetchCount += 1;
      return { card: CARD, jws: "jws", etag: '"e"', cachedAt: 1000 };
    };
    await loadCallerCard("https://a", cache, fetcher);
    await loadCallerCard("https://a", cache, fetcher);
    await loadCallerCard("https://a", cache, fetcher);
    expect(fetchCount).toBe(1);
  });

  it("re-fetches after TTL expiry", async () => {
    let now = 1000;
    const cache = new CallerCardCache(() => now);
    let fetchCount = 0;
    const fetcher: CallerCardFetcher = async () => {
      fetchCount += 1;
      return { card: CARD, jws: "jws", etag: '"e"', cachedAt: now };
    };
    await loadCallerCard("https://a", cache, fetcher);
    now += A2A_CARD_CACHE_TTL_S + 1;
    await loadCallerCard("https://a", cache, fetcher);
    expect(fetchCount).toBe(2);
  });
});
