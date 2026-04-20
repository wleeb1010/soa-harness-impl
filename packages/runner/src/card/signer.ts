import { CompactSign, type CryptoKey, type KeyObject } from "jose";
import { jcsBytes, sha256Hex } from "@soa-harness/core";

export type JwsAlg = "EdDSA" | "ES256" | "RS256";
export type PrivateKeyLike = CryptoKey | KeyObject | Uint8Array;

export interface CardSignOptions {
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
  /**
   * RFC 7515 §4.1.6 cert chain, leaf-first (index 0 = signing cert). Each entry
   * is a base64-encoded DER X.509 certificate. Required per Core §6.1.1 row 1:
   * the Agent Card JWS protected header MUST carry `alg`, `kid`, and `x5c`.
   */
  x5c: string[];
}

export interface SignedCard {
  canonicalBody: Buffer;
  detachedJws: string;
  etag: string;
}

export async function signAgentCard(opts: CardSignOptions): Promise<SignedCard> {
  if (!Array.isArray(opts.x5c) || opts.x5c.length === 0) {
    throw new Error("signer: x5c must be a non-empty array (Core §6.1.1 requires leaf-first cert chain)");
  }

  const canonicalBody = jcsBytes(opts.card);
  const compact = await new CompactSign(canonicalBody)
    .setProtectedHeader({
      alg: opts.alg,
      kid: opts.kid,
      typ: "soa-agent-card+jws",
      x5c: opts.x5c
    })
    .sign(opts.privateKey);

  const parts = compact.split(".");
  if (parts.length !== 3) {
    throw new Error(`signer: expected a 3-segment compact JWS, got ${parts.length} segments`);
  }
  const detachedJws = `${parts[0]}..${parts[2]}`;
  const etag = `"${sha256Hex(canonicalBody)}"`;

  return { canonicalBody, detachedJws, etag };
}
