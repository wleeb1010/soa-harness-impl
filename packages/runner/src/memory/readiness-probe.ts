/**
 * §8.3 MemoryUnavailableStartup readiness probe (Finding S / SV-MEM-03).
 *
 * §8.3 line 581: "On timeout or connection failure during startup: the
 * Runner MUST fail startup with `MemoryUnavailableStartup`. Fail-open
 * to empty memory is NOT permitted."
 *
 * The startup sequence runs `searchMemories({limit:1})` against the
 * Memory MCP endpoint with retries. On persistent failure the Runner
 * binds its HTTP listener but /ready reports 503 with reason
 * "memory-mcp-unavailable" — orchestrators don't route traffic until
 * the operator repairs the dependency (spec intent: no traffic flows
 * to a Runner that would silently truncate the agent's context).
 *
 * The probe never flips /ready back to ready on its own after a failed
 * startup — §8.3 treats this as a terminal startup failure. A fresh
 * Runner process must be started after the operator fixes the
 * dependency. (A background recovery loop would technically satisfy
 * "never flip /ready to 200" only if the probe stayed stuck, but
 * matching the spec's one-shot startup semantics keeps the state
 * machine small + predictable for conformance.)
 */

import type { ReadinessProbe, ReadinessReason } from "../probes/types.js";

export class MemoryReadinessProbe implements ReadinessProbe {
  /**
   * `null` — probe hasn't started yet (Runner still booting; paired with
   *          bootstrap-pending from BootOrchestrator).
   * `"ready"` — probe completed successfully; memory MCP is reachable.
   * `"unavailable"` — probe failed persistently; /ready stays 503 forever.
   */
  private state: "pending" | "ready" | "unavailable" = "pending";
  private lastError: string | null = null;

  markReady(): void {
    this.state = "ready";
    this.lastError = null;
  }

  markUnavailable(errorMessage: string): void {
    this.state = "unavailable";
    this.lastError = errorMessage;
  }

  check(): ReadinessReason | null {
    // `pending` means the probe is still running at startup — surface as
    // memory-mcp-unavailable so orchestrators can distinguish it from
    // bootstrap-pending (which is trust/card/CRL). `ready` → no reason.
    if (this.state === "ready") return null;
    return "memory-mcp-unavailable";
  }

  getState(): "pending" | "ready" | "unavailable" {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }
}

/**
 * Inert probe for deployments without Memory MCP wired (no
 * SOA_RUNNER_MEMORY_MCP_ENDPOINT). Always reports ready so it
 * composes cleanly into composeReadiness().
 */
export const MEMORY_READINESS_NOT_CONFIGURED: ReadinessProbe = {
  check: (): ReadinessReason | null => null
};
