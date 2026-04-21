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
  /**
   * Optional auto-refresh scheduler interval in milliseconds. Default 30
   * minutes (half of §10.6's 60-minute refresh ceiling — leaves slack for
   * transient fetcher failures to retry before the cache ages into
   * `stale-but-valid`, and well under the 2-hour `staleCeilingMs` that
   * would flip /ready to 503 crl-stale). Setting 0 disables the scheduler
   * (tests + demo scenarios that control the clock directly).
   */
  refreshIntervalMs?: number;
  /**
   * Injected error logger for refresh failures. Defaults to console.warn —
   * a failed refresh isn't fatal (the cache keeps serving the last good
   * CRL until it ages past `staleCeilingMs`), but operators need to see
   * it. Tests pass a recorder.
   */
  onRefreshError?: (uri: string, err: unknown) => void;
}

const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

/**
 * §5.4 boot orchestrator + readiness aggregator.
 *
 * On `boot()`: walks `anchors`, calls `crl.refresh(${anchor.uri}/crl.json)` on
 * each. Any single failure halts boot and leaves `/ready` reporting
 * `crl-stale`. Success transitions the orchestrator into "booted" state and
 * schedules §10.6 periodic refresh.
 *
 * Auto-refresh (§10.6): once booted, a timer fires every `refreshIntervalMs`
 * and calls `crl.refresh(uri)` for each anchor. A failure logs via
 * `onRefreshError` and leaves the last-good entry in place — the cache's
 * `anchorFreshness()` surface eventually surfaces the staleness to `/ready`
 * via `check()` if failures persist past `staleCeilingMs`.
 *
 * `check()` (the ReadinessProbe interface) reassesses on every call:
 *   - pre-boot: returns `bootstrap-pending` (or the specific gate reason
 *     from the most recent boot attempt)
 *   - post-boot: walks each anchor's CRL freshness; any `expired` flips
 *     the probe to `crl-stale`. Plug-in predicates (tool pool, persistence,
 *     audit sink) produce their own reasons. All predicates clean → 200.
 *
 * `stop()` clears the scheduler. SIGINT/SIGTERM handlers MUST call it so
 * the process exits cleanly.
 */
export class BootOrchestrator implements ReadinessProbe {
  private booted = false;
  private lastBootReason: ReadinessReason = "bootstrap-pending";
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;
  private readonly onRefreshError: (uri: string, err: unknown) => void;

  constructor(private readonly opts: BootOrchestratorOptions) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.onRefreshError =
      opts.onRefreshError ??
      ((uri, err) => {
        // eslint-disable-next-line no-console
        console.warn(`[boot] CRL auto-refresh failed for ${uri}: ${String(err)}`);
      });
  }

  async boot(): Promise<void> {
    this.lastBootReason = "crl-stale";
    for (const anchor of this.opts.anchors) {
      await this.opts.crl.refresh(`${anchor.uri}/crl.json`);
    }
    this.booted = true;
    this.lastBootReason = "bootstrap-pending"; // unused once booted
    this.scheduleAutoRefresh();
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

  /**
   * Stop the auto-refresh timer. Safe to call multiple times. Bin's SIGINT/
   * SIGTERM handlers MUST call this so Node's event loop shuts down cleanly.
   */
  stop(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Force one immediate refresh pass across all anchors. Test helper. */
  async refreshAllNow(): Promise<void> {
    for (const anchor of this.opts.anchors) {
      const uri = `${anchor.uri}/crl.json`;
      try {
        await this.opts.crl.refresh(uri);
      } catch (err) {
        this.onRefreshError(uri, err);
      }
    }
  }

  private scheduleAutoRefresh(): void {
    if (this.refreshIntervalMs <= 0) return; // explicitly disabled
    if (this.refreshTimer !== null) return; // idempotent
    // unref() lets the process exit even if only the timer is pending.
    this.refreshTimer = setInterval(() => {
      void this.refreshAllNow();
    }, this.refreshIntervalMs);
    if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref();
  }
}
