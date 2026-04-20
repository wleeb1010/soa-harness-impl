import { webcrypto } from "node:crypto";
import { compactVerify, importX509 } from "jose";
import { X509Certificate } from "@peculiar/x509";
import type { JwsAlg } from "./signer.js";

export type CardVerifyFailureReason =
  | "detached-jws-malformed"
  | "header-malformed"
  | "typ-mismatch"
  | "alg-not-allowlisted"
  | "kid-missing"
  | "x5c-missing"
  | "cert-parse-failed"
  | "signature-invalid"
  | "x5c-chain-incomplete"
  | "chain-anchor-mismatch";

export class CardSignatureFailed extends Error {
  override readonly name = "CardSignatureFailed";
  readonly reason: CardVerifyFailureReason;
  readonly detail: string | undefined;

  constructor(reason: CardVerifyFailureReason, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

export interface TrustAnchor {
  issuer: string;
  spki_sha256: string;
  uri: string;
  publisher_kid?: string;
}

export interface VerifyAgentCardOptions {
  canonicalBody: Buffer | Uint8Array;
  detachedJws: string;
  trustAnchors: TrustAnchor[];
  allowedAlgs?: JwsAlg[];
}

export interface VerifiedCard {
  matchedAnchor: TrustAnchor;
  leafSpkiSha256: string;
  chain: string[];
  protectedHeader: Record<string, unknown>;
}

const DEFAULT_ALLOWED_ALGS: readonly JwsAlg[] = ["EdDSA", "ES256", "RS256"] as const;
const EXPECTED_TYP = "soa-agent-card+jws";

function derToPem(der: string): string {
  const chunked = der.match(/.{1,64}/g)?.join("\n") ?? der;
  return `-----BEGIN CERTIFICATE-----\n${chunked}\n-----END CERTIFICATE-----\n`;
}

async function spkiSha256Hex(cert: X509Certificate): Promise<string> {
  const hash = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(hash).toString("hex");
}

/**
 * Verify a detached Agent Card JWS per Core §6.1 + §6.1.1.
 *
 * Steps:
 *   1. Parse the `h..s` detached form and decode the protected header.
 *   2. Assert typ = "soa-agent-card+jws", alg in allowlist, kid + x5c present.
 *   3. Parse x5c[0] as DER X.509, import it into jose, and verify the signature
 *      over `canonicalBody` by reconstructing the compact form and passing it
 *      through jose.compactVerify.
 *   4. Walk x5c left → right, computing the SHA-256 of each cert's
 *      SubjectPublicKeyInfo DER, and match against trustAnchors[].spki_sha256.
 *      The first match wins. A chain that does not terminate at an anchor is
 *      rejected with `chain-anchor-mismatch`.
 *
 * Full RFC 5280 path validation (basicConstraints, keyUsage, intermediate-signs-
 * leaf walk) is SV-SIGN-04 territory — outside M1 gate IDs. This function does
 * the minimum Core §6.1.1 requires: leaf signature correct + chain SPKI match.
 */
export async function verifyAgentCardJws(opts: VerifyAgentCardOptions): Promise<VerifiedCard> {
  const allowedAlgs = opts.allowedAlgs ?? [...DEFAULT_ALLOWED_ALGS];

  const parts = opts.detachedJws.split(".");
  if (parts.length !== 3 || parts[1] !== "") {
    throw new CardSignatureFailed(
      "detached-jws-malformed",
      `expected RFC 7515 detached "h..s" form, got ${parts.length} segments (payload="${parts[1] ?? ""}")`
    );
  }
  const protectedB64 = parts[0] ?? "";
  const signature = parts[2] ?? "";

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(protectedB64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new CardSignatureFailed(
      "header-malformed",
      `cannot decode protected header`,
      err instanceof Error ? err.message : String(err)
    );
  }

  if (header.typ !== EXPECTED_TYP) {
    throw new CardSignatureFailed("typ-mismatch", `expected typ=${EXPECTED_TYP}, got ${JSON.stringify(header.typ)}`);
  }
  if (typeof header.alg !== "string" || !allowedAlgs.includes(header.alg as JwsAlg)) {
    throw new CardSignatureFailed(
      "alg-not-allowlisted",
      `alg=${JSON.stringify(header.alg)} not in allowlist ${JSON.stringify(allowedAlgs)}`
    );
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new CardSignatureFailed("kid-missing", "protected header missing kid");
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || !x5c.every((entry) => typeof entry === "string")) {
    throw new CardSignatureFailed("x5c-missing", "protected header x5c MUST be a non-empty string array");
  }
  const chain = x5c as string[];

  const chainCerts: X509Certificate[] = [];
  for (const [i, der] of chain.entries()) {
    try {
      chainCerts.push(new X509Certificate(Buffer.from(der, "base64")));
    } catch (err) {
      throw new CardSignatureFailed(
        "cert-parse-failed",
        `cannot parse x5c[${i}] as DER X.509 certificate`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const leafCert = chainCerts[0];
  if (!leafCert) {
    throw new CardSignatureFailed("x5c-missing", "x5c array was empty after parse");
  }

  let verifyKey: Awaited<ReturnType<typeof importX509>>;
  try {
    verifyKey = await importX509(derToPem(chain[0] as string), header.alg as string);
  } catch (err) {
    throw new CardSignatureFailed(
      "cert-parse-failed",
      `could not import x5c[0] as a verification key for alg=${header.alg as string}`,
      err instanceof Error ? err.message : String(err)
    );
  }

  // Reconstruct the compact JWS with the canonical body as base64url payload
  // and let jose do the signature check. The alternative — flattenedVerify with
  // a separately-supplied payload — requires the payload to be pre-encoded in
  // base64url, which is the same string, so this form is no less efficient.
  const payloadB64 = Buffer.from(opts.canonicalBody).toString("base64url");
  const reassembled = `${protectedB64}.${payloadB64}.${signature}`;
  try {
    await compactVerify(reassembled, verifyKey);
  } catch (err) {
    throw new CardSignatureFailed(
      "signature-invalid",
      "JWS signature does not verify against x5c[0]'s public key",
      err instanceof Error ? err.message : String(err)
    );
  }

  let leafSpki: string | undefined;
  let matchedAnchor: TrustAnchor | undefined;
  for (const [i, cert] of chainCerts.entries()) {
    const spki = await spkiSha256Hex(cert);
    if (i === 0) leafSpki = spki;
    const anchor = opts.trustAnchors.find((a) => a.spki_sha256.toLowerCase() === spki);
    if (anchor) {
      matchedAnchor = anchor;
      break;
    }
  }

  if (!matchedAnchor) {
    throw new CardSignatureFailed(
      "chain-anchor-mismatch",
      `no certificate in x5c chain has an SPKI matching any of the ${opts.trustAnchors.length} declared trust anchors`
    );
  }

  return {
    matchedAnchor,
    leafSpkiSha256: leafSpki ?? "",
    chain,
    protectedHeader: header
  };
}
