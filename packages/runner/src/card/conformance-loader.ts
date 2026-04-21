import { readFileSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { X509Certificate } from "@peculiar/x509";
import { jcs, sha256Hex } from "@soa-harness/core";

/**
 * Per the rewritten M1 plan T-04: the impl MUST load the pinned conformance
 * card fixture and substitute a placeholder SPKI hash with the runtime
 * signing cert's actual SPKI hash. The ONLY field the impl may rewrite is
 * `security.trustAnchors[*].spki_sha256` when it equals the sentinel string.
 * Every other field MUST pass through unchanged; tampering raises
 * `conformance-fixture-tampered`.
 */
export const PLACEHOLDER_SPKI = "__IMPL_REPLACES_SPKI_AT_LOAD__________________________________";

/**
 * Pinned SHA-256 of JCS(conformance-card) at spec commit 80680cd76129.
 * From MANIFEST.json.supplementary_artifacts[
 *   path="test-vectors/conformance-card/agent-card.json"
 * ].sha256. Bumped manually when the pin moves and the fixture changes.
 */
export const PINNED_CONFORMANCE_CARD_DIGEST =
  "87c50683bb01fca6a1e95b9bae7e18e8aad7831e9ecb3e9e61061caf67534e05";

export interface LoadConformanceCardOptions {
  fixturePath: string;
  /** Base64 DER of the runtime signing cert — x5c[0]. */
  leafCertDerBase64: string;
  /** Override for the pinned digest. Tests / pin-bump transitions use this. */
  expectedDigest?: string;
}

export class ConformanceFixtureTampered extends Error {
  override readonly name = "ConformanceFixtureTampered";
  constructor(
    readonly reason: "digest-mismatch" | "missing-placeholder" | "read-failure",
    message: string
  ) {
    super(message);
  }
}

async function spkiSha256Hex(derBase64: string): Promise<string> {
  const cert = new X509Certificate(Buffer.from(derBase64, "base64"));
  const hash = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(hash).toString("hex");
}

export interface LoadedConformanceCard {
  card: Record<string, unknown>;
  substitutedSpki: string;
  fixtureDigest: string;
}

/**
 * Load the conformance card, verify integrity, substitute the placeholder SPKI.
 *
 * Order of operations:
 *   1. Read the raw fixture text.
 *   2. Parse as JSON and re-serialize via JCS.
 *   3. Hash the canonical bytes; assert matches the pinned digest. Mismatch
 *      throws ConformanceFixtureTampered("digest-mismatch", ...).
 *   4. Walk security.trustAnchors — exactly one entry MUST carry the
 *      PLACEHOLDER_SPKI sentinel. Fewer → missing-placeholder. More is fine
 *      (we substitute all of them with the runtime key's SPKI).
 *   5. Compute SPKI SHA-256 of the runtime signing cert.
 *   6. Substitute and return the resulting card object.
 *
 * The substituted card is the one served at /.well-known/agent-card.json and
 * signed into .jws. The integrity check (step 3) runs against the UNsubstituted
 * fixture bytes — that is the hash-target in the pinned spec MANIFEST.
 */
export async function loadConformanceCard(
  opts: LoadConformanceCardOptions
): Promise<LoadedConformanceCard> {
  if (!existsSync(opts.fixturePath)) {
    throw new ConformanceFixtureTampered(
      "read-failure",
      `RUNNER_CARD_FIXTURE file not found at ${opts.fixturePath}`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(opts.fixturePath, "utf8");
  } catch (err) {
    throw new ConformanceFixtureTampered(
      "read-failure",
      `could not read ${opts.fixturePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const canonicalBytes = Buffer.from(jcs(parsed), "utf8");
  const fixtureDigest = sha256Hex(canonicalBytes);
  const expected = opts.expectedDigest ?? PINNED_CONFORMANCE_CARD_DIGEST;
  if (fixtureDigest !== expected) {
    throw new ConformanceFixtureTampered(
      "digest-mismatch",
      `conformance card JCS digest ${fixtureDigest} does not match pinned ${expected}`
    );
  }

  const security = parsed["security"] as Record<string, unknown> | undefined;
  const anchors = (security?.["trustAnchors"] as Array<Record<string, unknown>> | undefined) ?? [];
  const placeholderHolders = anchors.filter((a) => a["spki_sha256"] === PLACEHOLDER_SPKI);
  if (placeholderHolders.length === 0) {
    throw new ConformanceFixtureTampered(
      "missing-placeholder",
      `no trustAnchors entry carries the SPKI placeholder — fixture already substituted or malformed`
    );
  }

  const runtimeSpki = await spkiSha256Hex(opts.leafCertDerBase64);
  for (const anchor of placeholderHolders) {
    anchor["spki_sha256"] = runtimeSpki;
  }

  return { card: parsed, substitutedSpki: runtimeSpki, fixtureDigest };
}
