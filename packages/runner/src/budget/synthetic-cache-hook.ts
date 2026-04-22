/**
 * §13.3 synthetic cache-hit test hook (Finding AD / SV-BUD-04).
 *
 * Environment variable:
 *   RUNNER_SYNTHETIC_CACHE_HIT=<n>
 *     When set (non-negative integer), every committed decision's
 *     recordTurn call stamps prompt_tokens_cached=completion_tokens_cached=<n>
 *     on the TurnRecord. Without this hook, M3's no-dispatcher state
 *     leaves both counters at 0 — but validators need a way to exercise
 *     /budget/projection's cache_accounting totals without a real LLM
 *     round-trip. The env var is a deterministic injection surface.
 *
 * Production guard — same loopback-only pattern as §11.3.1 / §8.4.1 /
 * §11.2.1: refuse startup with this env set on non-loopback hosts.
 */

export class SyntheticCacheHitOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `SyntheticCacheHitOnPublicListener: RUNNER_SYNTHETIC_CACHE_HIT is set ` +
        `and listener binds to non-loopback host "${host}". This hook MUST ` +
        `NOT be reachable by untrusted principals — it deterministically ` +
        `skews cache-accounting totals reported on /budget/projection.`
    );
    this.name = "SyntheticCacheHitOnPublicListener";
  }
}

export interface SyntheticCacheHitConfig {
  /** Parsed value. When undefined, the hook is disabled. */
  value?: number;
}

export function parseSyntheticCacheHitEnv(env: NodeJS.ProcessEnv): SyntheticCacheHitConfig {
  const raw = env["RUNNER_SYNTHETIC_CACHE_HIT"];
  if (raw === undefined || raw.length === 0) return {};
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `RUNNER_SYNTHETIC_CACHE_HIT must be a non-negative integer, got "${raw}"`
    );
  }
  return { value: n };
}

export function assertSyntheticCacheHitListenerSafe(opts: {
  cfg: SyntheticCacheHitConfig;
  host: string;
}): void {
  if (opts.cfg.value === undefined) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new SyntheticCacheHitOnPublicListener(opts.host);
}
