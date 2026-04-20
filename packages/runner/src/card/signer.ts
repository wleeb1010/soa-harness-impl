import { CompactSign, type CryptoKey, type KeyObject } from "jose";
import { jcsBytes, sha256Hex } from "@soa-harness/core";

export type JwsAlg = "EdDSA" | "ES256" | "RS256";
export type PrivateKeyLike = CryptoKey | KeyObject | Uint8Array;

export interface CardSignOptions {
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
}

export interface SignedCard {
  canonicalBody: Buffer;
  detachedJws: string;
  etag: string;
}

export async function signAgentCard(opts: CardSignOptions): Promise<SignedCard> {
  const canonicalBody = jcsBytes(opts.card);
  const compact = await new CompactSign(canonicalBody)
    .setProtectedHeader({ alg: opts.alg, kid: opts.kid, typ: "soa-card+jws" })
    .sign(opts.privateKey);

  const parts = compact.split(".");
  if (parts.length !== 3) {
    throw new Error(`signer: expected a 3-segment compact JWS, got ${parts.length} segments`);
  }
  const detachedJws = `${parts[0]}..${parts[2]}`;
  const etag = `"${sha256Hex(canonicalBody)}"`;

  return { canonicalBody, detachedJws, etag };
}
