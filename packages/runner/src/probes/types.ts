/**
 * Closed-set /ready failure reasons per Core §5.4 line 207.
 * Adding a value is a spec change, not a PR to this repo.
 */
export type ReadinessReason =
  | "bootstrap-pending"
  | "tool-pool-initializing"
  | "persistence-unwritable"
  | "audit-sink-unreachable"
  | "crl-stale";

/** A readiness probe returns null when the Runner is ready, or a closed-enum reason when not. */
export interface ReadinessProbe {
  check(): ReadinessReason | null;
}

/** Default stand-in: the Runner is always ready. Used before later components wire in real checks. */
export const alwaysReady: ReadinessProbe = { check: () => null };
