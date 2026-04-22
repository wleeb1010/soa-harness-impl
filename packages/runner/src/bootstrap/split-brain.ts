/**
 * §5.3.2 / Finding AR — multi-channel split-brain detection
 * (SV-BOOT-05).
 *
 * When `SOA_BOOTSTRAP_SECONDARY_CHANNEL` points at a second
 * observable bootstrap channel, the Runner compares its
 * `publisher_kid` to the authoritative channel. Disagreement raises
 * `HostHardeningInsufficient(bootstrap-split-brain)` per §5.3.2
 * rule 2; identical `publisher_kid` + `spki_sha256` is NOT a
 * split-brain per §5.3.2 rule 3 (multiple channels agreeing is fine).
 */

import { existsSync, readFileSync } from "node:fs";
import { HostHardeningInsufficient, type InitialTrust } from "./types.js";

export interface SecondaryChannelSnapshot {
  publisher_kid?: string;
  spki_sha256?: string;
  issuer?: string;
  [extra: string]: unknown;
}

export interface DetectSplitBrainOptions {
  authoritative: InitialTrust;
  secondaryPath: string;
  authoritativeChannel: string;
}

export function detectSplitBrain(opts: DetectSplitBrainOptions): void {
  const { authoritative, secondaryPath, authoritativeChannel } = opts;

  if (!existsSync(secondaryPath)) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `SOA_BOOTSTRAP_SECONDARY_CHANNEL points at a non-existent file ${secondaryPath}`,
      "The env var is set but no channel snapshot is readable."
    );
  }

  let secondary: SecondaryChannelSnapshot;
  try {
    secondary = JSON.parse(readFileSync(secondaryPath, "utf8")) as SecondaryChannelSnapshot;
  } catch (err) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `SOA_BOOTSTRAP_SECONDARY_CHANNEL at ${secondaryPath} is not valid JSON`,
      err instanceof Error ? err.message : String(err)
    );
  }

  const secondaryKid = secondary.publisher_kid;
  const secondarySpki = secondary.spki_sha256;

  // §5.3.2 rule 3 — identical values across channels is agreement.
  if (
    typeof secondaryKid === "string" &&
    typeof secondarySpki === "string" &&
    secondaryKid === authoritative.publisher_kid &&
    secondarySpki === authoritative.spki_sha256
  ) {
    return;
  }

  // §5.3.2 rule 4 — rotation overlap: if secondary matches the
  // successor_publisher_kid, it's a lagging observation, not a split.
  if (
    typeof authoritative.successor_publisher_kid === "string" &&
    secondaryKid === authoritative.successor_publisher_kid
  ) {
    return;
  }

  // §5.3.2 rule 2 — disagreement → fail-closed.
  throw new HostHardeningInsufficient(
    "bootstrap-split-brain",
    `secondary bootstrap channel disagrees with authoritative channel`,
    `authoritative(${authoritativeChannel})=publisher_kid=${authoritative.publisher_kid} ` +
      `secondary=publisher_kid=${secondaryKid ?? "<missing>"}`
  );
}
