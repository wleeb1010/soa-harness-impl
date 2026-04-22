export type BootstrapChannel = "sdk-pinned" | "operator-bundled" | "dnssec-txt";

export interface InitialTrustSignature {
  alg: "EdDSA" | "ES256" | "RS256";
  kid: string;
  value: string;
}

export interface InitialTrust {
  soaHarnessVersion: "1.0";
  publisher_kid: string;
  spki_sha256: string;
  issuer: string;
  issued_at?: string;
  not_after?: string;
  successor_publisher_kid?: string;
  channel?: BootstrapChannel;
  signature?: InitialTrustSignature;
}

export type BootstrapFailReason =
  | "bootstrap-missing"
  | "bootstrap-malformed"
  | "bootstrap-invalid-schema"
  | "bootstrap-expired"
  | "bootstrap-channel-unsupported"
  /** §5.3.2 rule 1 — SOA_BOOTSTRAP_CHANNEL env var absent. */
  | "bootstrap-channel-undeclared"
  /** §5.3.1 / Finding AQ — revocation file observed with matching publisher_kid. */
  | "bootstrap-revoked"
  /** §5.3.2 rule 2 / Finding AR — dissenting publisher on secondary channel. */
  | "bootstrap-split-brain";

export class HostHardeningInsufficient extends Error {
  override readonly name = "HostHardeningInsufficient";
  readonly reason: BootstrapFailReason;
  readonly detail: string | undefined;

  constructor(reason: BootstrapFailReason, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}
