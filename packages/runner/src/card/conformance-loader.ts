import { readFileSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { dirname, resolve, relative, sep } from "node:path";
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
/**
 * Per the L-21 spec revision (commit 8c10ce9), the placeholder is now a valid
 * hex64 SHA-256 value — the bytes are `sha256("soa-harness/v1.0/conformance-card/spki-placeholder")`
 * or equivalent; the value is cryptographically arbitrary and has no meaning
 * beyond "the impl MUST rewrite me". The raw fixture now schema-validates
 * cleanly without the loader's skipSchemaValidation escape hatch.
 */
export const PLACEHOLDER_SPKI = "16dc826f86941f2b6876f4f0f59d91f0021dacbd4ff17b76bbc9d39685250606";

/**
 * Historical constant for back-compat + explicit override. NOT used at load
 * time — L-30 introduced a second conformance card fixture (v1.1) at a
 * distinct path, so the loader now looks up the per-path digest from the
 * pinned MANIFEST.json dynamically. This value remains exported so pin-
 * bump regression tests + the archaeology trail stay intact.
 */
export const PINNED_CONFORMANCE_CARD_DIGEST =
  "d29be9897b1faa7a8bebda10adda5d01f9243529dcb0f30de68f59c0248741ab";

export interface LoadConformanceCardOptions {
  fixturePath: string;
  /** Base64 DER of the runtime signing cert — x5c[0]. */
  leafCertDerBase64: string;
  /**
   * Back-compat escape hatch. When set, the loader skips the MANIFEST lookup
   * and compares against this exact digest. Used by unit tests that mock the
   * MANIFEST without a full spec repo on disk, and by operators who pin a
   * single digest out-of-band. Production loads SHOULD omit it so the
   * per-path MANIFEST lookup enforces L-30 cross-swap protection.
   */
  expectedDigest?: string;
  /**
   * Root of the pinned spec repo (where MANIFEST.json lives). When omitted
   * and `expectedDigest` is also omitted, the loader walks up from
   * `fixturePath` until it finds a `MANIFEST.json` file — in the standard
   * sibling-repo layout this resolves to `../soa-harness=specification`.
   * Bounded to 8 levels to avoid a symlink loop.
   */
  specRoot?: string;
}

export type ConformanceFixtureTamperedReason =
  | "digest-mismatch"
  | "missing-placeholder"
  | "read-failure"
  | "manifest-missing"
  | "manifest-path-not-found"
  | "manifest-malformed";

export class ConformanceFixtureTampered extends Error {
  override readonly name = "ConformanceFixtureTampered";
  constructor(
    readonly reason: ConformanceFixtureTamperedReason,
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
  /**
   * The MANIFEST entry that matched. Absent when the caller used the
   * `expectedDigest` escape hatch (no MANIFEST lookup happened).
   */
  manifestPath?: string;
}

/**
 * Walk upward from `start` looking for a `MANIFEST.json` at the repo root.
 * Returns the directory containing MANIFEST.json, or undefined when none is
 * found within `maxDepth` levels.
 */
function findSpecRoot(start: string, maxDepth = 8): string | undefined {
  let current = resolve(start);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = resolve(current, "MANIFEST.json");
    if (existsSync(candidate)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

interface ManifestEntry {
  name?: string;
  path?: string;
  sha256?: string;
  canonicalization?: string;
}

/**
 * Resolve the expected SHA-256 for `fixturePath` by looking up the matching
 * entry in the pinned MANIFEST.json. Returns the sha256 plus the canonical
 * MANIFEST path string so callers can include it in logs / errors.
 *
 * L-30 cross-swap protection: the lookup keys on the FIXTURE PATH, not on
 * the fixture bytes. Serving v1.0 bytes at the v1.1 path pins the loader
 * against the v1.1 digest — the computed digest won't match and the load
 * refuses with `digest-mismatch`, which is what we want.
 */
function lookupManifestDigest(
  specRoot: string,
  fixturePath: string
): { expectedDigest: string; manifestPath: string } {
  const manifestJsonPath = resolve(specRoot, "MANIFEST.json");
  if (!existsSync(manifestJsonPath)) {
    throw new ConformanceFixtureTampered(
      "manifest-missing",
      `MANIFEST.json not found at ${manifestJsonPath}`
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestJsonPath, "utf8"));
  } catch (err) {
    throw new ConformanceFixtureTampered(
      "manifest-malformed",
      `could not parse MANIFEST.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const supp = (manifest as { artifacts?: { supplementary_artifacts?: ManifestEntry[] } }).artifacts
    ?.supplementary_artifacts;
  if (!Array.isArray(supp)) {
    throw new ConformanceFixtureTampered(
      "manifest-malformed",
      `MANIFEST.json missing artifacts.supplementary_artifacts array`
    );
  }

  // Normalize the fixture path relative to the spec root. MANIFEST entries
  // use POSIX separators (forward slash); normalize Windows back-slashes.
  const rel = relative(specRoot, resolve(fixturePath)).split(sep).join("/");
  const entry = supp.find((e) => typeof e.path === "string" && e.path === rel);
  if (!entry) {
    throw new ConformanceFixtureTampered(
      "manifest-path-not-found",
      `MANIFEST has no supplementary_artifacts entry for path "${rel}" ` +
        `(resolved from ${fixturePath} against spec root ${specRoot})`
    );
  }
  if (typeof entry.sha256 !== "string") {
    throw new ConformanceFixtureTampered(
      "manifest-malformed",
      `MANIFEST entry for "${rel}" is missing a sha256 field`
    );
  }
  return { expectedDigest: entry.sha256, manifestPath: rel };
}

/**
 * Load the conformance card, verify integrity, substitute the placeholder SPKI.
 *
 * Order of operations:
 *   1. Read the raw fixture text.
 *   2. Parse as JSON and re-serialize via JCS.
 *   3. Resolve the expected digest:
 *        a. If `expectedDigest` is passed, use it verbatim (test/override path).
 *        b. Else find the spec root (explicit `specRoot` or auto-detect by
 *           walking up from `fixturePath`) and look up the matching entry
 *           in MANIFEST.json's artifacts.supplementary_artifacts.
 *   4. Hash the canonical bytes; assert matches the resolved digest.
 *      Mismatch throws ConformanceFixtureTampered("digest-mismatch", ...).
 *   5. Walk security.trustAnchors — at least one entry MUST carry the
 *      PLACEHOLDER_SPKI sentinel. Fewer → missing-placeholder. More is fine
 *      (we substitute all of them with the runtime key's SPKI).
 *   6. Compute SPKI SHA-256 of the runtime signing cert.
 *   7. Substitute and return the resulting card object.
 *
 * The substituted card is the one served at /.well-known/agent-card.json and
 * signed into .jws. The integrity check (step 4) runs against the UNsubstituted
 * fixture bytes — that is the hash-target in the pinned spec MANIFEST.
 *
 * L-30 cross-swap protection: because step 3b keys the digest lookup by the
 * FIXTURE PATH, serving v1.0 bytes at the v1.1 path pins against v1.1's
 * digest and refuses the load. The pinned MANIFEST is authoritative.
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

  let expectedDigest: string;
  let manifestPath: string | undefined;
  if (opts.expectedDigest !== undefined) {
    expectedDigest = opts.expectedDigest;
  } else {
    const specRoot = opts.specRoot ?? findSpecRoot(dirname(opts.fixturePath));
    if (!specRoot) {
      throw new ConformanceFixtureTampered(
        "manifest-missing",
        `could not find MANIFEST.json by walking up from ${opts.fixturePath}; ` +
          `pass opts.specRoot or opts.expectedDigest explicitly`
      );
    }
    const lookup = lookupManifestDigest(specRoot, opts.fixturePath);
    expectedDigest = lookup.expectedDigest;
    manifestPath = lookup.manifestPath;
  }

  if (fixtureDigest !== expectedDigest) {
    throw new ConformanceFixtureTampered(
      "digest-mismatch",
      `conformance card JCS digest ${fixtureDigest} does not match MANIFEST-pinned ${expectedDigest}` +
        (manifestPath ? ` for path "${manifestPath}"` : "")
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

  const result: LoadedConformanceCard = { card: parsed, substitutedSpki: runtimeSpki, fixtureDigest };
  if (manifestPath !== undefined) result.manifestPath = manifestPath;
  return result;
}
