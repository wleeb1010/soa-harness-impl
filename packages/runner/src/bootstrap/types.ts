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
  | "bootstrap-channel-unsupported";

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
