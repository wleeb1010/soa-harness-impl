/**
 * §5.3.3 Bootstrap Testability Env Hooks — parser + production guard
 * (Findings AP/AQ/AR).
 *
 * Env vars (all share the §8.4.1 / §11.3.1 / §11.2.1 loopback-only
 * guard pattern):
 *
 *   SOA_BOOTSTRAP_DNSSEC_TXT=<file-path>         — AP / SV-BOOT-03
 *   RUNNER_BOOTSTRAP_POLL_TICK_MS=<ms>           — AQ / SV-BOOT-04
 *   SOA_BOOTSTRAP_REVOCATION_FILE=<file-path>    — AQ / SV-BOOT-04
 *   SOA_BOOTSTRAP_SECONDARY_CHANNEL=<file-path>  — AR / SV-BOOT-05
 *
 * All four MUST NOT be reachable by untrusted principals. Runner MUST
 * refuse startup when any is set on a non-loopback listener.
 */

export class BootstrapHookOnPublicListener extends Error {
  constructor(host: string, whichVars: readonly string[]) {
    super(
      `BootstrapHookOnPublicListener: ${whichVars.join(", ")} set and ` +
        `listener binds to non-loopback host "${host}". Per §5.3.3 the ` +
        `bootstrap test hooks MUST NOT be reachable by untrusted principals.`
    );
    this.name = "BootstrapHookOnPublicListener";
  }
}

export interface BootstrapEnvConfig {
  /** AP — when set, the DNSSEC TXT path is read from this file. */
  dnssecTxtPath?: string;
  /** AQ — poll tick in ms. Default 3_600_000 (1 h) when unset. */
  pollTickMs?: number;
  /** AQ — revocation file to watch on each poll tick. */
  revocationFilePath?: string;
  /** AR — secondary observable channel file. */
  secondaryChannelPath?: string;
}

export function parseBootstrapEnv(env: NodeJS.ProcessEnv): BootstrapEnvConfig {
  const out: BootstrapEnvConfig = {};

  const dnssec = env["SOA_BOOTSTRAP_DNSSEC_TXT"];
  if (dnssec !== undefined && dnssec.length > 0) out.dnssecTxtPath = dnssec;

  const tick = env["RUNNER_BOOTSTRAP_POLL_TICK_MS"];
  if (tick !== undefined && tick.length > 0) {
    const n = Number.parseInt(tick, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `RUNNER_BOOTSTRAP_POLL_TICK_MS must be a positive integer (ms), got "${tick}"`
      );
    }
    out.pollTickMs = n;
  }

  const rev = env["SOA_BOOTSTRAP_REVOCATION_FILE"];
  if (rev !== undefined && rev.length > 0) out.revocationFilePath = rev;

  const sec = env["SOA_BOOTSTRAP_SECONDARY_CHANNEL"];
  if (sec !== undefined && sec.length > 0) out.secondaryChannelPath = sec;

  return out;
}

export function assertBootstrapEnvHooksListenerSafe(opts: {
  env: BootstrapEnvConfig;
  host: string;
}): void {
  const set: string[] = [];
  if (opts.env.dnssecTxtPath !== undefined) set.push("SOA_BOOTSTRAP_DNSSEC_TXT");
  if (opts.env.pollTickMs !== undefined) set.push("RUNNER_BOOTSTRAP_POLL_TICK_MS");
  if (opts.env.revocationFilePath !== undefined) set.push("SOA_BOOTSTRAP_REVOCATION_FILE");
  if (opts.env.secondaryChannelPath !== undefined) set.push("SOA_BOOTSTRAP_SECONDARY_CHANNEL");
  if (set.length === 0) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new BootstrapHookOnPublicListener(opts.host, set);
}
