import type { CrlCache } from "../crl/index.js";
import type { TrustAnchor } from "../card/verify.js";
import type { ReadinessProbe, ReadinessReason } from "../probes/index.js";

export interface BootOrchestratorOptions {
  /** Trust anchors whose CRLs must warm before /ready flips to 200. */
  anchors: readonly TrustAnchor[];
  /** The CRL cache to warm + poll. */
  crl: CrlCache;
  /**
   * When true (default), the orchestrator treats a missing Tool Registry /
   * audit sink / persistence probe as "not yet gated" and simply reports
   * bootstrap completion. M1 does not implement those extra gates; they
   * land as later milestones.
   */
  toolPoolReady?: () => boolean;
  persistenceWritable?: () => boolean;
  auditSinkReachable?: () => boolean;
}

/**
 * §5.4 boot orchestrator + readiness aggregator.
 *
 * On `boot()`: walks `anchors`, calls `crl.refresh(${anchor.uri}/crl.json)` on
 * each. Any single failure halts boot and leaves `/ready` reporting
 * `crl-stale`. Success transitions the orchestrator into "booted" state.
 *
 * `check()` (the ReadinessProbe interface) reassesses on every call:
 *   - pre-boot: returns `bootstrap-pending` (or the specific gate reason
 *     from the most recent boot attempt)
 *   - post-boot: walks each anchor's CRL freshness; any `expired` flips
 *     the probe to `crl-stale`. Plug-in predicates (tool pool, persistence,
 *     audit sink) produce their own reasons. All predicates clean → 200.
 */
export class BootOrchestrator implements ReadinessProbe {
  private booted = false;
  private lastBootReason: ReadinessReason = "bootstrap-pending";

  constructor(private readonly opts: BootOrchestratorOptions) {}

  async boot(): Promise<void> {
    this.lastBootReason = "crl-stale";
    for (const anchor of this.opts.anchors) {
      await this.opts.crl.refresh(`${anchor.uri}/crl.json`);
    }
    this.booted = true;
    this.lastBootReason = "bootstrap-pending"; // unused once booted
  }

  /** True once the initial `boot()` succeeded. Reassessment happens in `check()`. */
  get isBooted(): boolean {
    return this.booted;
  }

  check(): ReadinessReason | null {
    if (!this.booted) return this.lastBootReason;

    for (const anchor of this.opts.anchors) {
      const uri = `${anchor.uri}/crl.json`;
      if (this.opts.crl.anchorFreshness(uri) === "expired") {
        return "crl-stale";
      }
    }
    if (this.opts.toolPoolReady && !this.opts.toolPoolReady()) {
      return "tool-pool-initializing";
    }
    if (this.opts.persistenceWritable && !this.opts.persistenceWritable()) {
      return "persistence-unwritable";
    }
    if (this.opts.auditSinkReachable && !this.opts.auditSinkReachable()) {
      return "audit-sink-unreachable";
    }
    return null;
  }
}
