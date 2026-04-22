/**
 * §8.3 startup probe driver (Finding S).
 *
 * Invoked once at Runner boot when a MemoryMcpClient is configured.
 * Runs `searchMemories({limit:1})` with bounded retries; on success
 * flips the MemoryReadinessProbe to `ready`; on persistent failure
 * flips it to `unavailable` and the probe keeps /ready at 503 with
 * reason=memory-mcp-unavailable until the Runner is restarted.
 *
 * Writes to the System Event Log on each attempt outcome:
 *   success    category=MemoryLoad,   level=info,  code=memory-ready
 *   retry fail category=MemoryDegraded, level=warn, code=memory-probe-retry
 *   final fail category=Error,        level=error, code=memory-unavailable-startup
 *
 * Runner startup log mirrors the final outcome with a stderr FATAL
 * line on persistent failure so operators see the misconfiguration
 * at boot without digging into the System Event Log.
 */

import type { MemoryMcpClient } from "./mcp-client.js";
import type { MemoryReadinessProbe } from "./readiness-probe.js";
import type { SystemLogBuffer } from "../system-log/index.js";

export interface StartupMemoryProbeOptions {
  client: MemoryMcpClient;
  probe: MemoryReadinessProbe;
  systemLog?: SystemLogBuffer;
  /** Default 3. */
  maxAttempts?: number;
  /** Default 500 ms between attempts. */
  backoffMs?: number;
  /**
   * Synthetic session id used for boot-time System Event Log records.
   * Default "ses_runner_boot____" (matches the ^ses_[A-Za-z0-9]{16,}$
   * pattern so the /logs/system/recent surface accepts it uniformly).
   */
  bootSessionId?: string;
  /** Logger for operator-visible lines. */
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  /** Injected sleep for test isolation. Defaults to setTimeout Promise. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_BOOT_SESSION_ID = "ses_runner_boot_____";

export async function runStartupMemoryProbe(
  opts: StartupMemoryProbeOptions
): Promise<{ ready: boolean; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const bootSessionId = opts.bootSessionId ?? DEFAULT_BOOT_SESSION_ID;
  const log = opts.log ?? ((m) => console.log(m));
  const errorLog = opts.errorLog ?? ((m) => console.error(m));
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: string = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await opts.client.searchMemories({ query: "", limit: 1, sharing_scope: "session" });
      opts.probe.markReady();
      log(
        `[start-runner] Memory MCP startup probe succeeded on attempt ${attempt}/${maxAttempts}`
      );
      if (opts.systemLog) {
        opts.systemLog.write({
          session_id: bootSessionId,
          category: "MemoryLoad",
          level: "info",
          code: "memory-ready",
          message: `Memory MCP readiness probe succeeded on attempt ${attempt}/${maxAttempts}`,
          data: { attempts_used: attempt, max_attempts: maxAttempts }
        });
      }
      return { ready: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (opts.systemLog) {
        opts.systemLog.write({
          session_id: bootSessionId,
          category: "MemoryDegraded",
          level: "warn",
          code: "memory-probe-retry",
          message: `Memory MCP probe attempt ${attempt}/${maxAttempts} failed: ${lastError}`,
          data: { attempt, max_attempts: maxAttempts }
        });
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs);
      }
    }
  }

  const msg = `MemoryUnavailableStartup: all ${maxAttempts} probe attempts failed (last error: ${lastError})`;
  opts.probe.markUnavailable(msg);
  errorLog(
    `[start-runner] FATAL: ${msg}. /ready will remain 503 with reason=memory-mcp-unavailable; restart the Runner after repairing Memory MCP connectivity.`
  );
  if (opts.systemLog) {
    opts.systemLog.write({
      session_id: bootSessionId,
      category: "Error",
      level: "error",
      code: "memory-unavailable-startup",
      message: msg,
      data: { attempts: maxAttempts }
    });
  }
  return { ready: false, attempts: maxAttempts };
}
