/**
 * §8.4.1 consolidation test-hook env-var parser + production guard.
 *
 * Environment variables:
 *   RUNNER_CONSOLIDATION_TICK_MS     default 60000 (1 min poll)
 *   RUNNER_CONSOLIDATION_ELAPSED_MS  default 0     (matches §8.4
 *                                                   24 h semantic when
 *                                                   interpreted as 0 =
 *                                                   fire on every tick
 *                                                   that crosses the
 *                                                   default 24 h; BUT
 *                                                   impl treats 0 as
 *                                                   "always-fire-on-tick"
 *                                                   for test harnesses)
 *
 * Production guard — MUST refuse startup on non-loopback hosts when
 * either env var is set. Same pattern as §11.3.1 dynamic registration,
 * §11.2.1 AGENTS.md hook, §10.6.1 clock injection.
 */

export class ConsolidationHookOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `ConsolidationHookOnPublicListener: RUNNER_CONSOLIDATION_* env var is ` +
        `set and listener binds to non-loopback host "${host}". Per §8.4.1 ` +
        `the consolidation test hooks MUST NOT be reachable by untrusted principals.`
    );
    this.name = "ConsolidationHookOnPublicListener";
  }
}

export interface ConsolidationEnvConfig {
  /** Parsed RUNNER_CONSOLIDATION_TICK_MS, or undefined when unset. */
  tickIntervalMs?: number;
  /** Parsed RUNNER_CONSOLIDATION_ELAPSED_MS, or undefined when unset. */
  intervalMs?: number;
}

export function parseConsolidationEnv(env: NodeJS.ProcessEnv): ConsolidationEnvConfig {
  const out: ConsolidationEnvConfig = {};
  const tick = env["RUNNER_CONSOLIDATION_TICK_MS"];
  if (tick !== undefined && tick.length > 0) {
    const n = Number.parseInt(tick, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `RUNNER_CONSOLIDATION_TICK_MS must be a positive integer (ms), got "${tick}"`
      );
    }
    out.tickIntervalMs = n;
  }
  const elapsed = env["RUNNER_CONSOLIDATION_ELAPSED_MS"];
  if (elapsed !== undefined && elapsed.length > 0) {
    const n = Number.parseInt(elapsed, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `RUNNER_CONSOLIDATION_ELAPSED_MS must be a non-negative integer (ms), got "${elapsed}"`
      );
    }
    out.intervalMs = n;
  }
  return out;
}

export function assertConsolidationHooksListenerSafe(opts: {
  env: ConsolidationEnvConfig;
  host: string;
}): void {
  // When neither env var is set the guard is inert (no test hook is
  // active; production behavior is untouched).
  if (opts.env.tickIntervalMs === undefined && opts.env.intervalMs === undefined) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new ConsolidationHookOnPublicListener(opts.host);
}
