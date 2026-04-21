import type { ReadinessProbe, ReadinessReason } from "./types.js";

/**
 * Chain multiple ReadinessProbes with short-circuit evaluation. Returns the
 * first non-null reason, or null when all probes say ready. Used by the bin
 * to compose BootOrchestrator (CRL + tool-pool) with the AuditSink's
 * readinessReason() call.
 */
export function composeReadiness(...probes: ReadinessProbe[]): ReadinessProbe {
  return {
    check(): ReadinessReason | null {
      for (const p of probes) {
        const reason = p.check();
        if (reason !== null) return reason;
      }
      return null;
    }
  };
}
