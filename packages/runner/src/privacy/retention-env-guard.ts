/**
 * §10.7.3 SV-PRIV-04 retention-sweep test-hook env-var parser +
 * production guard (Finding AH).
 *
 * Environment variables:
 *   RUNNER_RETENTION_SWEEP_TICK_MS     default 300000 (5 min poll)
 *   RUNNER_RETENTION_SWEEP_INTERVAL_MS default 86400000 (24 h)
 *
 * Production guard — MUST refuse startup on non-loopback hosts when
 * either env var is set. Same pattern as §8.4.1 consolidation hooks,
 * §11.3.1 dynamic registration, §10.6.1 clock injection. Validator
 * drives a sub-second retention sweep during SV-PRIV-04 probes so the
 * test completes without waiting a day.
 */

export class RetentionSweepHookOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `RetentionSweepHookOnPublicListener: RUNNER_RETENTION_SWEEP_* env var ` +
        `is set and listener binds to non-loopback host "${host}". Per §10.7.3 ` +
        `the retention-sweep test hooks MUST NOT be reachable by untrusted principals.`
    );
    this.name = "RetentionSweepHookOnPublicListener";
  }
}

export interface RetentionSweepEnvConfig {
  /** Parsed RUNNER_RETENTION_SWEEP_TICK_MS, or undefined when unset. */
  tickIntervalMs?: number;
  /** Parsed RUNNER_RETENTION_SWEEP_INTERVAL_MS, or undefined when unset. */
  intervalMs?: number;
}

export function parseRetentionSweepEnv(env: NodeJS.ProcessEnv): RetentionSweepEnvConfig {
  const out: RetentionSweepEnvConfig = {};
  const tick = env["RUNNER_RETENTION_SWEEP_TICK_MS"];
  if (tick !== undefined && tick.length > 0) {
    const n = Number.parseInt(tick, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `RUNNER_RETENTION_SWEEP_TICK_MS must be a positive integer (ms), got "${tick}"`
      );
    }
    out.tickIntervalMs = n;
  }
  const interval = env["RUNNER_RETENTION_SWEEP_INTERVAL_MS"];
  if (interval !== undefined && interval.length > 0) {
    const n = Number.parseInt(interval, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `RUNNER_RETENTION_SWEEP_INTERVAL_MS must be a non-negative integer (ms), got "${interval}"`
      );
    }
    out.intervalMs = n;
  }
  return out;
}

export function assertRetentionSweepListenerSafe(opts: {
  env: RetentionSweepEnvConfig;
  host: string;
}): void {
  if (opts.env.tickIntervalMs === undefined && opts.env.intervalMs === undefined) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new RetentionSweepHookOnPublicListener(opts.host);
}
