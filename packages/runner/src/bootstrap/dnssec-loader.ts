/**
 * §5.3.3 Finding AP — DNSSEC bootstrap fixture loader (SV-BOOT-03).
 *
 * Reads a pinned JSON file of shape `{txt_record, ad_bit, empty}` in
 * place of a live DNSSEC resolver query. Returns a parsed
 * `InitialTrust`-shape object on the valid-AD-bit path, or throws
 * `HostHardeningInsufficient` on the two failure scenarios
 * (missing AD bit, empty response).
 *
 * The txt_record format is `publisher_kid=<v>; spki_sha256=<hex>; issuer="<text>"`
 * per §5.3.2 rule 1. All three fields are required.
 */

import { readFileSync, existsSync } from "node:fs";
import { HostHardeningInsufficient, type InitialTrust } from "./types.js";

export interface DnssecTxtFixture {
  txt_record: string;
  ad_bit: boolean;
  empty: boolean;
}

export interface LoadDnssecBootstrapOptions {
  path: string;
  expectedPublisherKid?: string;
}

/** Parse a DNSSEC TXT record string into an InitialTrust-shape object. */
export function parseDnssecTxtRecord(txt: string): {
  publisher_kid: string;
  spki_sha256: string;
  issuer: string;
} {
  const out: Record<string, string> = {};
  // Fields are `key=value` pairs separated by `; `. Values may be
  // quoted (issuer uses double quotes) — strip the surrounding quotes.
  for (const pair of txt.split(/;\s*/)) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  const publisher_kid = out["publisher_kid"];
  const spki_sha256 = out["spki_sha256"];
  const issuer = out["issuer"];
  if (!publisher_kid || !spki_sha256 || !issuer) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `DNSSEC TXT record missing required fields (need publisher_kid + spki_sha256 + issuer)`,
      `parsed keys: ${Object.keys(out).join(", ") || "<none>"}`
    );
  }
  return { publisher_kid, spki_sha256, issuer };
}

export function loadDnssecBootstrap(opts: LoadDnssecBootstrapOptions): InitialTrust {
  const { path, expectedPublisherKid } = opts;

  if (!existsSync(path)) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `DNSSEC fixture not found at ${path}`,
      "SOA_BOOTSTRAP_DNSSEC_TXT points at a non-existent path."
    );
  }

  let parsed: DnssecTxtFixture;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as DnssecTxtFixture;
  } catch (err) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `DNSSEC fixture at ${path} is not valid JSON`,
      err instanceof Error ? err.message : String(err)
    );
  }

  if (parsed.empty === true) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `DNSSEC response is empty at ${path}`,
      "No _soa-trust TXT record returned — deployment cannot establish a bootstrap anchor."
    );
  }

  if (parsed.ad_bit !== true) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `DNSSEC response at ${path} lacks the AD (Authentic Data) bit`,
      "Without AD validation the response is unauthenticated; §5.3 requires a DNSSEC-validated channel."
    );
  }

  if (typeof parsed.txt_record !== "string" || parsed.txt_record.length === 0) {
    throw new HostHardeningInsufficient(
      "bootstrap-malformed",
      `DNSSEC fixture at ${path} has an empty or missing txt_record`,
      "AD bit is set but the TXT body is absent."
    );
  }

  const fields = parseDnssecTxtRecord(parsed.txt_record);

  if (expectedPublisherKid !== undefined && fields.publisher_kid !== expectedPublisherKid) {
    throw new HostHardeningInsufficient(
      "bootstrap-missing",
      `DNSSEC TXT record publisher_kid=${fields.publisher_kid} does not match pinned ${expectedPublisherKid}`,
      "SDK-pinned bootstrap mismatch."
    );
  }

  const trust: InitialTrust = {
    soaHarnessVersion: "1.0",
    publisher_kid: fields.publisher_kid,
    spki_sha256: fields.spki_sha256,
    issuer: fields.issuer,
    channel: "dnssec-txt"
  };
  return trust;
}
