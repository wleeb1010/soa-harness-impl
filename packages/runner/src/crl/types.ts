export interface CrlRevokedKid {
  kid: string;
  revoked_at: string;
  reason: "compromise" | "rotation" | "administrative" | "unspecified";
}

export interface Crl {
  issuer: string;
  issued_at: string;
  not_after: string;
  revoked_kids: CrlRevokedKid[];
}

/**
 * Three-state freshness machine per UI §7.3.1 + Core §10.6:
 *
 *   fresh            — last successful fetch within the Runner's refresh interval
 *                      (default 1 hour) AND still within the CRL's own not_after.
 *                      Accept decisions signed by any non-revoked kid.
 *   stale-but-valid  — last fetch older than refresh interval but still within
 *                      2 hours of wall clock AND within CRL not_after. Accept
 *                      and schedule background refresh.
 *   expired          — past CRL not_after OR more than 2 hours since last
 *                      successful fetch. Fail-closed: reject decisions under
 *                      this anchor with the appropriate category error.
 */
export type CrlFreshness = "fresh" | "stale-but-valid" | "expired";

export interface CrlCheckOutcome {
  freshness: CrlFreshness;
  revoked: boolean;
  revokedEntry?: CrlRevokedKid;
  /** Human-readable reason when freshness is "expired". */
  failureReason?: "crl-expired" | "crl-unreachable" | "crl-missing";
}

export type CrlFetcher = (anchorUri: string) => Promise<Crl>;
