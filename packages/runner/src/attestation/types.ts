export type PdaAlg = "EdDSA" | "ES256" | "RS256";
export type PdaDecision = "allow" | "deny";
export type PdaScope = "once" | "session" | "always";

export interface CanonicalDecision {
  prompt_id: string;
  session_id: string;
  tool_name: string;
  args_digest: string;
  decision: PdaDecision;
  scope: PdaScope;
  not_before: string;
  not_after: string;
  nonce: string;
  handler_kid: string;
}

export type PdaFailureReason =
  | "jws-malformed"
  | "header-malformed"
  | "typ-mismatch"
  | "alg-not-allowlisted"
  | "kid-missing"
  | "kid-mismatch"
  | "payload-malformed"
  | "schema-invalid"
  | "not-yet-valid"
  | "expired"
  | "window-too-wide"
  | "signature-invalid"
  | "handler-key-unknown"
  | "handler-key-revoked";

export class PdaVerifyFailed extends Error {
  override readonly name = "PdaVerifyFailed";
  readonly reason: PdaFailureReason;
  readonly detail: string | undefined;

  constructor(reason: PdaFailureReason, message: string, detail?: string) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}
