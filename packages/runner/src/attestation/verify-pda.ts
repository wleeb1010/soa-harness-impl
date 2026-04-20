import { compactVerify, type CryptoKey, type KeyObject } from "jose";
import { registry } from "@soa-harness/schemas";
import { PdaVerifyFailed, type CanonicalDecision, type PdaAlg } from "./types.js";

/**
 * Resolves a handler key from its kid. Returning null signals the kid is unknown
 * to the Runner's enrollment store (§7.3) and the PDA MUST be rejected with
 * `handler-key-unknown`.
 */
export type HandlerKeyResolver = (kid: string) => Promise<CryptoKey | KeyObject | Uint8Array | null>;

/**
 * Optional CRL check. Returning true means the kid is on the revocation list
 * under its trust anchor — the PDA MUST be rejected with `handler-key-revoked`.
 * Callers that pass the CrlCache.check result can map that into this shape.
 */
export type KidRevokedCheck = (kid: string) => Promise<boolean>;

export interface VerifyPdaOptions {
  /** Compact JWS (RFC 7515 compact form: "h.p.s"). */
  pdaJws: string;
  resolveVerifyKey: HandlerKeyResolver;
  isRevoked?: KidRevokedCheck;
  allowedAlgs?: PdaAlg[];
  /** Clock skew tolerance in seconds. Default: 60 per Core §1 PDA window. */
  skewSeconds?: number;
  /** Maximum permitted `not_after - not_before` in seconds. Default: 900 (15 min). */
  maxWindowSeconds?: number;
  now?: () => Date;
}

export interface VerifiedPda {
  decision: CanonicalDecision;
  protectedHeader: Record<string, unknown>;
}

const DEFAULT_ALGS: readonly PdaAlg[] = ["EdDSA", "ES256", "RS256"] as const;
const EXPECTED_TYP = "soa-pda+jws";
const DEFAULT_SKEW_SECONDS = 60;
const DEFAULT_MAX_WINDOW_SECONDS = 15 * 60;

export async function verifyPda(opts: VerifyPdaOptions): Promise<VerifiedPda> {
  const allowedAlgs = opts.allowedAlgs ?? [...DEFAULT_ALGS];
  const skewMs = (opts.skewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000;
  const maxWindowMs = (opts.maxWindowSeconds ?? DEFAULT_MAX_WINDOW_SECONDS) * 1000;
  const now = (opts.now ?? (() => new Date()))();

  const parts = opts.pdaJws.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new PdaVerifyFailed("jws-malformed", `PDA JWS must be compact "h.p.s" form, got ${parts.length} segments`);
  }
  const [headerB64, payloadB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new PdaVerifyFailed(
      "header-malformed",
      "cannot decode protected header",
      err instanceof Error ? err.message : String(err)
    );
  }

  if (header.typ !== EXPECTED_TYP) {
    throw new PdaVerifyFailed("typ-mismatch", `expected typ=${EXPECTED_TYP}, got ${JSON.stringify(header.typ)}`);
  }
  if (typeof header.alg !== "string" || !allowedAlgs.includes(header.alg as PdaAlg)) {
    throw new PdaVerifyFailed(
      "alg-not-allowlisted",
      `alg=${JSON.stringify(header.alg)} not in ${JSON.stringify(allowedAlgs)}`
    );
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new PdaVerifyFailed("kid-missing", "protected header missing kid");
  }

  let decision: CanonicalDecision;
  try {
    decision = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as CanonicalDecision;
  } catch (err) {
    throw new PdaVerifyFailed(
      "payload-malformed",
      "cannot decode JWS payload",
      err instanceof Error ? err.message : String(err)
    );
  }

  const validate = registry["canonical-decision"];
  if (!validate(decision)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new PdaVerifyFailed("schema-invalid", "payload fails canonical-decision.schema.json", detail);
  }

  if (decision.handler_kid !== header.kid) {
    throw new PdaVerifyFailed(
      "kid-mismatch",
      `handler_kid in payload (${decision.handler_kid}) does not equal kid in header (${header.kid as string})`
    );
  }

  const notBefore = new Date(decision.not_before);
  const notAfter = new Date(decision.not_after);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) {
    throw new PdaVerifyFailed("schema-invalid", "not_before / not_after are not RFC 3339 date-times");
  }
  if (notAfter.getTime() - notBefore.getTime() > maxWindowMs) {
    throw new PdaVerifyFailed(
      "window-too-wide",
      `PDA window ${notAfter.getTime() - notBefore.getTime()} ms exceeds max ${maxWindowMs} ms per Core §1`
    );
  }
  if (now.getTime() + skewMs < notBefore.getTime()) {
    throw new PdaVerifyFailed(
      "not-yet-valid",
      `now=${now.toISOString()} is before not_before=${decision.not_before} (skew=${skewMs / 1000}s)`
    );
  }
  if (now.getTime() - skewMs > notAfter.getTime()) {
    throw new PdaVerifyFailed(
      "expired",
      `now=${now.toISOString()} is after not_after=${decision.not_after} (skew=${skewMs / 1000}s)`
    );
  }

  const key = await opts.resolveVerifyKey(header.kid);
  if (!key) {
    throw new PdaVerifyFailed("handler-key-unknown", `no enrolled public key for kid=${header.kid as string}`);
  }

  if (opts.isRevoked) {
    const revoked = await opts.isRevoked(header.kid);
    if (revoked) {
      throw new PdaVerifyFailed("handler-key-revoked", `kid=${header.kid as string} is on the CRL`);
    }
  }

  try {
    await compactVerify(opts.pdaJws, key);
  } catch (err) {
    throw new PdaVerifyFailed(
      "signature-invalid",
      "PDA JWS signature does not verify against the resolved handler key",
      err instanceof Error ? err.message : String(err)
    );
  }

  return { decision, protectedHeader: header };
}
