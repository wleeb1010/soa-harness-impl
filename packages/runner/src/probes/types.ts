/**
 * Closed-set /ready failure reasons per Core §5.4 line 207.
 * Adding a value is a spec change, not a PR to this repo.
 *
 * L-38 impl extension: `memory-mcp-unavailable` surfaces the
 * MemoryUnavailableStartup state from §8.3 line 581 ("Fail-open to
 * empty memory is NOT permitted"). The spec's §5.4 enum predates the
 * L-34 Memory MCP wiring; Finding S / SV-MEM-03 treats the string as
 * validator-observed contract. A formal §5.4 extension is tracked for
 * the next pin bump.
 */
export type ReadinessReason =
  | "bootstrap-pending"
  | "tool-pool-initializing"
  | "persistence-unwritable"
  | "audit-sink-unreachable"
  | "crl-stale"
  | "memory-mcp-unavailable";

/** A readiness probe returns null when the Runner is ready, or a closed-enum reason when not. */
export interface ReadinessProbe {
  check(): ReadinessReason | null;
}

/** Default stand-in: the Runner is always ready. Used before later components wire in real checks. */
export const alwaysReady: ReadinessProbe = { check: () => null };
