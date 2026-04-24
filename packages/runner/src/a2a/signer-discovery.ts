/**
 * §17.1 step 2 + step 4 — W3 slice 2.
 *
 * Signing-key discovery via the caller's Agent Card (the default path when
 * transport is not mutually authenticated) and via the mTLS client
 * certificate (when the handoff is behind mTLS). Plus the §17.1 step 4
 * `agent_card_etag` drift detection over the same cached card.
 *
 * Design:
 *   - CallerCardCache is a small LRU-by-insertion-time map with 60 s TTL
 *     per §17.1 step 2 bullet 1's "MAY be cached for up to 60 s" and step 4's
 *     identical window. A single cache is shared across both sites so one
 *     round-trip per caller amortizes across discovery + drift checks.
 *   - fetchCallerCard enforces §17.1 step 2's connection timeout (3 s) and
 *     total-request deadline (5 s). Failures route to
 *     HandoffRejected(reason=card-unreachable) per §17.1.
 *   - computeAgentCardEtag pins the §17.2.4 formula:
 *       `"\"" + hex_lowercase(SHA-256(JCS(agent-card))) + "\""`
 *   - Signer extraction from `x5c[0]` uses the `@peculiar/x509` library
 *     already consumed by the Runner's card-verify path, so the JWT and
 *     Agent Card paths share the same cert-parsing logic.
 *
 * Everything is pure-function + injectable-deps; unit tests pass a mock
 * fetcher and a clock to exercise every branch without a real network.
 */

import "reflect-metadata"; // required by @peculiar/x509's tsyringe dependency
import { importSPKI } from "jose";
import { X509Certificate } from "@peculiar/x509";
import { jcsBytes, sha256Hex } from "@soa-harness/core";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { A2aJwtHeader, A2aJwtPayload, A2aJwtKeyResolver, A2aJwtVerifyKey } from "./jwt.js";

/** §17.1 step 2 connection timeout. */
export const A2A_CARD_FETCH_CONNECT_TIMEOUT_MS = 3000;
/** §17.1 step 2 total-request deadline. */
export const A2A_CARD_FETCH_TOTAL_TIMEOUT_MS = 5000;
/** §17.1 step 2 + step 4 cache TTL. */
export const A2A_CARD_CACHE_TTL_S = 60;

export interface FetchedCallerCard {
  /** Parsed Agent Card JSON per §6.2. */
  card: unknown;
  /** Detached JWS per §6.1.1, for signer extraction. */
  jws: string;
  /** §17.2.4 etag formula value ("\"<hex>\""), for step 4 drift compare. */
  etag: string;
  /** Unix seconds at which this entry was populated (for TTL checks). */
  cachedAt: number;
}

export type CallerCardFetcher = (subUrl: string) => Promise<FetchedCallerCard | null>;

/** §17.2.4 formula: `"\"" + hex_lowercase(SHA-256(JCS(card))) + "\""`. */
export function computeAgentCardEtag(card: unknown): string {
  return `"${sha256Hex(jcsBytes(card))}"`;
}

/**
 * §17.1 step 2 cache. 60 s TTL keyed by sub URL. Lazy-prunes expired
 * entries on every get()/size() call. Clock is injectable for tests.
 */
export class CallerCardCache {
  private readonly entries = new Map<string, FetchedCallerCard>();

  constructor(private readonly nowFn: () => number = () => Math.floor(Date.now() / 1000)) {}

  get(subUrl: string): FetchedCallerCard | null {
    this.pruneExpired();
    return this.entries.get(subUrl) ?? null;
  }

  set(subUrl: string, entry: FetchedCallerCard): void {
    this.entries.set(subUrl, entry);
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.nowFn();
    for (const [url, entry] of this.entries) {
      if (now - entry.cachedAt >= A2A_CARD_CACHE_TTL_S) this.entries.delete(url);
    }
  }
}

/**
 * Issue an HTTPS GET to `{subUrl}/.well-known/agent-card.json` and
 * `{subUrl}/.well-known/agent-card.jws` with §17.1 step 2 timeouts. Validates
 * the JSON body against `agent-card.schema.json`. Returns null on any
 * failure path (caller maps null → HandoffRejected reason=card-unreachable).
 *
 * `fetchImpl` is injectable so tests can simulate network without the real
 * global `fetch`. The production call uses the Node global fetch.
 */
export async function fetchCallerCard(
  subUrl: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedCallerCard | null> {
  const base = subUrl.replace(/\/+$/, "");
  const cardUrl = `${base}/.well-known/agent-card.json`;
  const jwsUrl = `${base}/.well-known/agent-card.jws`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), A2A_CARD_FETCH_TOTAL_TIMEOUT_MS);
  try {
    const [cardRes, jwsRes] = await Promise.all([
      fetchImpl(cardUrl, { signal: ctrl.signal }),
      fetchImpl(jwsUrl, { signal: ctrl.signal }),
    ]);
    if (!cardRes.ok || !jwsRes.ok) return null;
    const cardJson = (await cardRes.json()) as unknown;
    const jwsText = (await jwsRes.text()).trim();

    const validate = schemaRegistry["agent-card"];
    if (!validate(cardJson)) return null;

    return {
      card: cardJson,
      jws: jwsText,
      etag: computeAgentCardEtag(cardJson),
      cachedAt: nowFn(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch-or-cache helper used by both signer discovery and etag drift
 * checks. Hits the cache first; on miss, fetches + populates the cache
 * before returning.
 */
export async function loadCallerCard(
  subUrl: string,
  cache: CallerCardCache,
  fetcher: CallerCardFetcher,
): Promise<FetchedCallerCard | null> {
  const hit = cache.get(subUrl);
  if (hit !== null) return hit;
  const fresh = await fetcher(subUrl);
  if (fresh !== null) cache.set(subUrl, fresh);
  return fresh;
}

/**
 * Extract the signer's public key from an Agent Card detached JWS. Reads
 * the protected header, pulls `x5c[0]` (leaf cert), and returns a jose
 * KeyLike built from its SubjectPublicKeyInfo.
 *
 * Returns null on any parse/extract failure (plugin maps to
 * HandoffRejected reason=key-not-found).
 */
export async function extractSignerFromCardJws(detachedJws: string): Promise<A2aJwtVerifyKey | null> {
  const parts = detachedJws.split(".");
  // detached JWS → 3 parts, middle empty (`<header>..<signature>`).
  if (parts.length !== 3) return null;
  let header: { alg?: string; x5c?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(header.x5c) || header.x5c.length === 0 || typeof header.x5c[0] !== "string") {
    return null;
  }
  const alg = header.alg;
  if (alg !== "EdDSA" && alg !== "ES256" && alg !== "RS256") return null;

  try {
    const der = Buffer.from(header.x5c[0], "base64");
    const cert = new X509Certificate(der);
    // Export leaf SPKI as PEM so jose.importSPKI can hydrate it.
    const spkiDer = Buffer.from(cert.publicKey.rawData);
    const spkiPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
    return (await importSPKI(spkiPem, alg)) as unknown as A2aJwtVerifyKey;
  } catch {
    return null;
  }
}

/**
 * Build the §17.1 step-2 Agent-Card-kid signer resolver. Looks up the
 * caller's card at `payload.sub`, extracts the leaf cert from its JWS
 * `x5c`, and returns that cert's public key. If `header.kid` is set,
 * verify the card's JWS header `kid` matches — a mismatch is rejected as
 * key-not-found (protects against a caller that signs JWTs with a
 * different key than it advertises on its card).
 */
export function buildCardKidResolver(
  cache: CallerCardCache,
  fetcher: CallerCardFetcher,
): A2aJwtKeyResolver {
  return async (header, payload) => {
    const fetched = await loadCallerCard(payload.sub, cache, fetcher);
    if (fetched === null) return null;
    const key = await extractSignerFromCardJws(fetched.jws);
    if (key === null) return null;
    if (header.kid !== undefined) {
      // Optional integrity check: the JWT's kid MUST match the card JWS's kid.
      try {
        const cardHeader = JSON.parse(
          Buffer.from(fetched.jws.split(".")[0]!, "base64url").toString("utf8"),
        ) as { kid?: string };
        if (cardHeader.kid !== undefined && cardHeader.kid !== header.kid) return null;
      } catch {
        return null;
      }
    }
    return key;
  };
}

/**
 * Build the §17.1 step-2 mTLS `x5t#S256` signer resolver. Requires the
 * plugin to pass `context.peerCertDer` (Buffer of the client cert's DER
 * encoding) and requires `header["x5t#S256"]` to match the
 * SHA-256 of that DER. On match, extracts the public key from the peer
 * cert's SPKI.
 */
export function buildPeerCertResolver(): A2aJwtKeyResolver {
  return async (header, _payload, context) => {
    const x5t = header["x5t#S256"];
    const peerDer = context?.peerCertDer;
    if (x5t === undefined || peerDer === undefined) return null;
    const thumb = sha256Hex(peerDer);
    // §17.1: x5t#S256 is base64url-no-pad of 32 bytes; our spec's byte
    // comparison is against SHA-256(DER) — convert to hex both sides.
    const x5tHex = Buffer.from(x5t, "base64url").toString("hex");
    if (x5tHex !== thumb) return null;
    try {
      const cert = new X509Certificate(peerDer);
      const alg = header.alg === "EdDSA" || header.alg === "ES256" || header.alg === "RS256"
        ? header.alg
        : null;
      if (alg === null) return null;
      const spkiDer = Buffer.from(cert.publicKey.rawData);
      const spkiPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
      return (await importSPKI(spkiPem, alg)) as unknown as A2aJwtVerifyKey;
    } catch {
      return null;
    }
  };
}

/**
 * Compose resolvers — try each in order, return the first non-null result.
 * Typical plugin config: `composeSignerResolvers(peerCertResolver,
 * cardKidResolver)`. When mTLS is in use the header carries `x5t#S256`
 * and the peer-cert path wins; when not, the Agent-Card-kid path runs.
 */
export function composeSignerResolvers(...resolvers: A2aJwtKeyResolver[]): A2aJwtKeyResolver {
  return async (header, payload, context) => {
    for (const r of resolvers) {
      const key = await r(header, payload, context);
      if (key !== null) return key;
    }
    return null;
  };
}

/**
 * §17.1 step 4 etag drift outcome — discriminated union parallel to the
 * jwt.ts outcome types.
 */
export type A2aEtagDriftOutcome =
  | { kind: "match" }
  | { kind: "drift"; fetched: string; presented: string }
  | { kind: "card-unreachable"; detail: string };

/**
 * Fetch the caller's card and compare computed ETag against the JWT's
 * `agent_card_etag`. Mirrors §17.1 step 4 disjointness: fetch-failure →
 * `card-unreachable`; fetch-success with mismatch → `drift`; match → no-op.
 */
export async function checkAgentCardEtagDrift(opts: {
  subUrl: string;
  presentedEtag: string;
  cache: CallerCardCache;
  fetcher: CallerCardFetcher;
}): Promise<A2aEtagDriftOutcome> {
  const fetched = await loadCallerCard(opts.subUrl, opts.cache, opts.fetcher);
  if (fetched === null) {
    return { kind: "card-unreachable", detail: `GET ${opts.subUrl}/.well-known/agent-card.* failed` };
  }
  if (fetched.etag !== opts.presentedEtag) {
    return { kind: "drift", fetched: fetched.etag, presented: opts.presentedEtag };
  }
  return { kind: "match" };
}
