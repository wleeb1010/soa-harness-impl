import { readFileSync, existsSync } from "node:fs";
import {
  verifyAgentCardJws,
  CardSignatureFailed,
  type TrustAnchor,
  type VerifiedCard
} from "./verify.js";

/**
 * T-06 — RUNNER_CARD_JWS loader.
 *
 * Reads a pre-supplied Agent Card detached JWS from disk and verifies it
 * against the Runner's loaded card body + trust anchors at boot. Failure
 * throws `CardSignatureFailed` (re-exported from the verifier) — callers
 * typically map that to a non-zero exit.
 *
 * When the env var is UNSET, the normal sign-with-ephemeral-key flow
 * applies; this loader is only invoked in `RUNNER_CARD_JWS=<path>` mode.
 */
export interface LoadExternalCardJwsOptions {
  jwsPath: string;
  canonicalBody: Buffer | Uint8Array;
  trustAnchors: TrustAnchor[];
}

export interface LoadedExternalJws {
  detachedJws: string;
  verified: VerifiedCard;
}

export async function loadAndVerifyExternalCardJws(
  opts: LoadExternalCardJwsOptions
): Promise<LoadedExternalJws> {
  if (!existsSync(opts.jwsPath)) {
    throw new CardSignatureFailed(
      "detached-jws-malformed",
      `RUNNER_CARD_JWS file not found at ${opts.jwsPath}`
    );
  }
  const raw = readFileSync(opts.jwsPath, "utf8").trim();
  if (raw.length === 0) {
    throw new CardSignatureFailed("detached-jws-malformed", `RUNNER_CARD_JWS at ${opts.jwsPath} is empty`);
  }
  const verified = await verifyAgentCardJws({
    canonicalBody: opts.canonicalBody,
    detachedJws: raw,
    trustAnchors: opts.trustAnchors
  });
  return { detachedJws: raw, verified };
}
