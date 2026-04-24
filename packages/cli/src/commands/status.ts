/**
 * soa status — prints a one-shot health summary of a Runner:
 *   - /health   → alive / soaHarnessVersion
 *   - /ready    → ready status + any readiness-probe failure reasons
 *   - /version  → runner_version + spec_commit_sha (when surfaced)
 *   - /audit/tail?limit=1 → most recent audit row timestamp (if authed)
 *
 * Exits 0 on alive+ready, 1 otherwise. Useful for shell health checks,
 * CI smoke steps, and interactive operator verification.
 */
import type { RunnerClientOptions } from "../client.js";
import { RunnerClient } from "../client.js";

export interface StatusCommandOptions extends RunnerClientOptions {
  /** Quiet mode — only exit code, no stdout. */
  quiet?: boolean;
}

export async function statusCommand(opts: StatusCommandOptions): Promise<number> {
  const client = new RunnerClient(opts);
  const out: Record<string, unknown> = { runner_url: opts.runnerUrl };
  let exitCode = 0;

  try {
    const health = await client.getHealth();
    out.health = health;
    if (health.status !== "alive") exitCode = 1;
  } catch (err) {
    out.health_error = (err as Error).message;
    exitCode = 1;
  }

  try {
    const ready = await client.getReady();
    out.ready = ready;
    if (ready.status !== "ready") exitCode = 1;
  } catch (err) {
    out.ready_error = (err as Error).message;
    exitCode = 1;
  }

  try {
    const version = await client.getVersion();
    out.version = version;
  } catch (err) {
    out.version_error = (err as Error).message;
  }

  if (opts.sessionBearer) {
    try {
      const tail = await client.getAuditTail(1);
      const latest = tail.records?.[0];
      out.last_audit_row = latest
        ? { timestamp: latest.timestamp, kind: latest.kind ?? null }
        : null;
    } catch (err) {
      out.audit_tail_error = (err as Error).message;
    }
  }

  if (!opts.quiet) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  }
  return exitCode;
}
