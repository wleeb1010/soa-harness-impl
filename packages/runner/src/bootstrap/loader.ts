import { readFileSync, existsSync } from "node:fs";
import { registry } from "@soa-harness/schemas";
import { HostHardeningInsufficient, type BootstrapChannel, type InitialTrust } from "./types.js";

export interface LoadInitialTrustOptions {
  path: string;
  expectedChannel?: BootstrapChannel;
  now?: Date;
}

export function loadInitialTrust(opts: LoadInitialTrustOptions): InitialTrust {
  const { path, expectedChannel = "sdk-pinned", now = new Date() } = opts;

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
      "bootstrap-schema-invalid",
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

  if (trust.channel !== undefined && trust.channel !== expectedChannel) {
    throw new HostHardeningInsufficient(
      "bootstrap-channel-unsupported",
      `initial-trust.json declares channel=${trust.channel} but Runner is configured for ${expectedChannel}`,
      "M1 only supports the SDK-pinned bootstrap channel; operator-bundled and DNSSEC-TXT are deferred."
    );
  }

  return trust;
}
