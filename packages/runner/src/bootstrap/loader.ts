import { readFileSync, existsSync } from "node:fs";
import { registry } from "@soa-harness/schemas";
import { HostHardeningInsufficient, type BootstrapChannel, type InitialTrust } from "./types.js";

export interface LoadInitialTrustOptions {
  path: string;
  /**
   * When set, reject the file unless its `channel` matches. Omit to accept any
   * value from the §5.3 enum (sdk-pinned / operator-bundled / dnssec-txt);
   * schema validation still runs, so an out-of-enum value still fails with
   * `bootstrap-invalid-schema`.
   */
  expectedChannel?: BootstrapChannel;
  /**
   * When set, the publisher_kid in the file MUST match this value. Any
   * mismatch fails with `bootstrap-missing` — the Runner is SDK-pinned to a
   * specific publisher and the bootstrap file points at a different identity.
   */
  expectedPublisherKid?: string;
  now?: Date;
}

export function loadInitialTrust(opts: LoadInitialTrustOptions): InitialTrust {
  const { path, expectedChannel, expectedPublisherKid, now = new Date() } = opts;

  if (!existsSync(path)) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `initial-trust.json not found at ${path}`,
      "Runner MUST fail startup when the §5.3 bootstrap file is absent."
    );
  }

  const raw = readFileSync(path, "utf8");
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `initial-trust.json at ${path} starts with a UTF-8 BOM`,
      "Schema requires UTF-8 without BOM per §5.3."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `initial-trust.json at ${path} is not valid JSON`,
      err instanceof Error ? err.message : String(err)
    );
  }

  const validate = registry["initial-trust"];
  if (!validate(parsed)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new HostHardeningInsufficient(
      "bootstrap-invalid-schema",
      `initial-trust.json at ${path} fails initial-trust.schema.json validation`,
      detail || "(no detail from ajv)"
    );
  }

  const trust = parsed as InitialTrust;

  if (trust.not_after !== undefined) {
    const expiresAt = new Date(trust.not_after);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new HostHardeningInsufficient(
        "bootstrap-malformed",
        `initial-trust.json at ${path} has unparseable not_after`,
        `value: ${trust.not_after}`
      );
    }
    if (now >= expiresAt) {
      throw new HostHardeningInsufficient(
        "bootstrap-expired",
        `initial-trust.json at ${path} expired at ${trust.not_after}`,
        `now=${now.toISOString()}, not_after=${expiresAt.toISOString()}`
      );
    }
  }

  if (expectedChannel !== undefined && trust.channel !== undefined && trust.channel !== expectedChannel) {
    throw new HostHardeningInsufficient(
      "bootstrap-channel-unsupported",
      `initial-trust.json declares channel=${trust.channel} but Runner is configured for ${expectedChannel}`,
      "Only the Runner's configured bootstrap channel is accepted when expectedChannel is pinned."
    );
  }

  if (expectedPublisherKid !== undefined && trust.publisher_kid !== expectedPublisherKid) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `initial-trust.json publisher_kid=${trust.publisher_kid} does not match the pinned ${expectedPublisherKid}`,
      "SDK-pinned bootstrap MUST match the compile-time publisher identity; mismatch is an attempt to substitute a different trust root."
    );
  }

  return trust;
}
