/**
 * §17.1 A2A JWT normative profile — W3 slice 1.
 *
 * Covers:
 *   - §17.1 step 1: alg allowlist {EdDSA, ES256, RS256}.
 *   - §17.1 step 2: signing-key discovery via caller-supplied resolver
 *     (static-key slice; Agent-Card-fetch + mTLS x5t#S256 land in slice 2).
 *   - §17.1 step 3: jti replay cache with exp+30s retention.
 *   - §17.1 general: claim presence + shape + lifetime ≤ 300s + aud match.
 *
 * Deferred to slice 2:
 *   - §17.1 step 4: agent_card_etag drift detection (requires HTTP fetch).
 *   - §17.1 step 2 (Agent Card fetch): resolve kid via GET(sub).
 *   - §17.1 step 2 (mTLS peer cert): resolve x5t#S256 against TLS peer.
 *
 * Error routing (verbatim §17.1 + §17.3):
 *   - alg not allowed   → HandoffRejected(reason=bad-alg)
 *   - key not resolved  → HandoffRejected(reason=key-not-found)
 *   - jti replay        → HandoffRejected(reason=jti-replay)
 *   - anything else     → AuthFailed (-32002)
 */

import { jwtVerify, type CryptoKey, type KeyObject } from "jose";

/** Public-key shapes jose accepts for JWS verification. */
export type A2aJwtVerifyKey = CryptoKey | KeyObject | Uint8Array;
import { a2aError } from "./errors.js";
import type { JsonRpcErrorResponse } from "./types.js";

/** §17.1 step 1 normative allowlist. Extending requires §19.4 spec change. */
export const A2A_JWT_ALLOWED_ALGS = ["EdDSA", "ES256", "RS256"] as const;
export type A2aJwtAlg = (typeof A2A_JWT_ALLOWED_ALGS)[number];

/** §17.1 `exp` ≤ `iat` + 300s. */
export const A2A_JWT_MAX_LIFETIME_S = 300;

/** §17.1 step 3 replay-window retention: `exp + 30s` from first observation. */
export const A2A_JWT_JTI_RETENTION_EXTRA_S = 30;

/** Conventional default for acceptable forward clock skew on `iat`. */
export const A2A_JWT_DEFAULT_CLOCK_SKEW_S = 60;

export interface A2aJwtHeader {
  alg: string;
  kid?: string;
  "x5t#S256"?: string;
  typ?: string;
}

export interface A2aJwtPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  agent_card_etag: string;
  [extra: string]: unknown;
}

/**
 * Verify outcome — discriminated union so the plugin wrapper can route each
 * case to the correct JSON-RPC error per §17.1/§17.3 without string-matching.
 */
export type A2aJwtVerifyOutcome =
  | { kind: "valid"; payload: A2aJwtPayload; header: A2aJwtHeader }
  | { kind: "auth-failed"; detail: string }
  | { kind: "bad-alg"; detail: string }
  | { kind: "key-not-found"; detail: string }
  | { kind: "jti-replay"; detail: string }
  | { kind: "signature-invalid"; detail: string };

/**
 * §17.1 step 3 jti replay cache. In-memory map of jti → retainUntil (unix
 * seconds). Callers pass a clock for testability; entries past retention
 * are pruned lazily on `has()` / `register()` / `size()` calls.
 *
 * Key scope is caller-determined. Per §17.1 "Cache MAY be per-connection
 * (mTLS-scoped) or per-(iss,aud) keyed." This class is keyed by bare jti;
 * a wrapping Map<scope, JtiReplayCache> or prefixed-jti convention gives
 * scope partitioning when needed.
 */
export class JtiReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly nowFn: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  has(jti: string): boolean {
    this.pruneExpired();
    return this.entries.has(jti);
  }

  /** Register a jti observed on a JWT with the given `exp` (unix seconds). */
  register(jti: string, exp: number): void {
    this.entries.set(jti, exp + A2A_JWT_JTI_RETENTION_EXTRA_S);
  }

  size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.nowFn();
    for (const [jti, retainUntil] of this.entries) {
      if (retainUntil <= now) this.entries.delete(jti);
    }
  }
}

/**
 * Signing-key resolver — caller provides this to `verifyA2aJwt`.
 *
 * W3 slice-1 callers typically build a Map<kid, KeyLike> over a small set
 * of known peers and return `map.get(header.kid) ?? null`. Slice 2 adds a
 * fallback that fetches the caller's Agent Card via the JWT `sub` URL and
 * resolves the signer per §17.1 step 2.
 *
 * A nullish return means discovery failed → `key-not-found`. The resolver
 * MUST NOT throw for a missing key; reserve throws for infrastructure
 * failures that should surface as 500-class errors.
 */
export type A2aJwtKeyResolver = (header: A2aJwtHeader) => Promise<A2aJwtVerifyKey | null>;

export interface VerifyA2aJwtOptions {
  /** The compact-JWT string pulled from the Authorization: Bearer header. */
  jwtCompact: string;
  /** The callee's own URL — must equal the JWT `aud` claim. */
  audience: string;
  /** §17.1 step 2 signing-key discovery function. */
  resolveKey: A2aJwtKeyResolver;
  /** §17.1 step 3 replay cache. */
  jtiCache: JtiReplayCache;
  /** Acceptable forward clock skew on `iat`. Default: 60s. */
  clockSkewS?: number;
  /** Clock source. Default: wall clock (unix seconds). */
  nowFn?: () => number;
}

function base64urlDecodeJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

export async function verifyA2aJwt(opts: VerifyA2aJwtOptions): Promise<A2aJwtVerifyOutcome> {
  const now = (opts.nowFn ?? (() => Math.floor(Date.now() / 1000)))();
  const clockSkew = opts.clockSkewS ?? A2A_JWT_DEFAULT_CLOCK_SKEW_S;

  // 3-segment compact JWT (header.payload.signature), all non-empty.
  const parts = opts.jwtCompact.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    return { kind: "auth-failed", detail: "JWT MUST be 3-segment compact form with non-empty segments" };
  }

  // Decode header + payload without trusting the signature yet.
  let header: A2aJwtHeader;
  let payload: A2aJwtPayload;
  try {
    header = base64urlDecodeJson<A2aJwtHeader>(parts[0]!);
  } catch (e) {
    return { kind: "auth-failed", detail: `JWT header decode failed: ${(e as Error).message}` };
  }
  try {
    payload = base64urlDecodeJson<A2aJwtPayload>(parts[1]!);
  } catch (e) {
    return { kind: "auth-failed", detail: `JWT payload decode failed: ${(e as Error).message}` };
  }

  // §17.1 step 1.
  if (typeof header.alg !== "string" || !A2A_JWT_ALLOWED_ALGS.includes(header.alg as A2aJwtAlg)) {
    return {
      kind: "bad-alg",
      detail: `alg="${header.alg}" not in §17.1 allowlist ${A2A_JWT_ALLOWED_ALGS.join(",")}`,
    };
  }

  // Claim presence + shape.
  for (const c of ["iss", "sub", "aud", "iat", "exp", "jti", "agent_card_etag"] as const) {
    if (payload[c] === undefined || payload[c] === null) {
      return { kind: "auth-failed", detail: `missing required claim "${c}"` };
    }
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    return { kind: "auth-failed", detail: "iat/exp MUST be numeric unix seconds" };
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    return { kind: "auth-failed", detail: "jti MUST be a non-empty string" };
  }
  if (typeof payload.iss !== "string" || typeof payload.sub !== "string" || typeof payload.aud !== "string") {
    return { kind: "auth-failed", detail: "iss/sub/aud MUST be strings" };
  }
  if (typeof payload.agent_card_etag !== "string") {
    return { kind: "auth-failed", detail: "agent_card_etag MUST be a string" };
  }

  // §17.1 lifetime + expiry + audience.
  if (payload.exp - payload.iat > A2A_JWT_MAX_LIFETIME_S) {
    return {
      kind: "auth-failed",
      detail: `JWT lifetime ${payload.exp - payload.iat}s exceeds §17.1 maximum ${A2A_JWT_MAX_LIFETIME_S}s`,
    };
  }
  if (payload.exp <= now) {
    return { kind: "auth-failed", detail: `JWT expired at exp=${payload.exp}, now=${now}` };
  }
  if (payload.iat > now + clockSkew) {
    return {
      kind: "auth-failed",
      detail: `JWT iat=${payload.iat} is > ${clockSkew}s in the future (now=${now})`,
    };
  }
  if (payload.aud !== opts.audience) {
    return { kind: "auth-failed", detail: `aud="${payload.aud}" != expected "${opts.audience}"` };
  }

  // §17.1 step 3 — check BEFORE signature verify so a replayed-invalid-sig
  // JWT still trips the replay surface, not AuthFailed.
  if (opts.jtiCache.has(payload.jti)) {
    return { kind: "jti-replay", detail: `jti="${payload.jti}" replayed within retention window` };
  }

  // §17.1 step 2 signing-key discovery.
  let key: A2aJwtVerifyKey | null;
  try {
    key = await opts.resolveKey(header);
  } catch (e) {
    return { kind: "key-not-found", detail: `resolveKey threw: ${(e as Error).message}` };
  }
  if (key === null) {
    return {
      kind: "key-not-found",
      detail: `no signing key resolved (kid=${header.kid ?? "<none>"}, x5t#S256=${header["x5t#S256"] ?? "<none>"})`,
    };
  }

  // Signature verify via jose. clockTolerance large so jose's internal
  // expiry/nbf/iat checks don't collide with the ones above — we want our
  // error routing, not jose's generic JWTExpired / JWTClaimValidationFailed.
  try {
    await jwtVerify(opts.jwtCompact, key, {
      audience: opts.audience,
      algorithms: [...A2A_JWT_ALLOWED_ALGS],
      clockTolerance: 3600,
    });
  } catch (e) {
    return { kind: "signature-invalid", detail: (e as Error).message };
  }

  // Register only AFTER successful verify so a bogus jti can't poison the
  // cache.
  opts.jtiCache.register(payload.jti, payload.exp);
  return { kind: "valid", payload, header };
}

/**
 * Convenience mapper — convert a verify outcome to the JSON-RPC response
 * the plugin should return, or `null` when the JWT is valid.
 */
export function a2aJwtOutcomeToError(
  id: string | number | null,
  outcome: A2aJwtVerifyOutcome,
): JsonRpcErrorResponse | null {
  switch (outcome.kind) {
    case "valid":
      return null;
    case "auth-failed":
      return a2aError(id, "AuthFailed", { message: outcome.detail });
    case "bad-alg":
      return a2aError(id, "HandoffRejected", { reason: "bad-alg", message: outcome.detail });
    case "key-not-found":
      return a2aError(id, "HandoffRejected", { reason: "key-not-found", message: outcome.detail });
    case "jti-replay":
      return a2aError(id, "HandoffRejected", { reason: "jti-replay", message: outcome.detail });
    case "signature-invalid":
      return a2aError(id, "AuthFailed", { message: `JWT signature invalid: ${outcome.detail}` });
  }
}
