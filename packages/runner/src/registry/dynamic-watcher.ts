/**
 * §11.3.1 Runtime Tool-Addition Test Hook.
 *
 * When SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION=<path> is set, the Runner
 * polls the named file; on any non-empty JSON-array content, each entry
 * is ingested into the global Tool Registry via `registry.addDynamic()`
 * and the file is truncated so a subsequent write triggers another
 * registration.
 *
 * Production guard: the env hook MUST NOT be reachable by untrusted
 * principals — Runners refuse startup with the env set on non-loopback.
 * Mirrors §10.6.1 clock-injection + §12.5.2 audit-sink guards.
 *
 * In-flight sessions' `tool_pool_hash` stays pinned (§11.3) — the
 * watcher updates ONLY the global registry; session-scoped pool hashes
 * are copied at POST /sessions time and never mutate mid-session.
 */

import { promises as fsp } from "node:fs";
import type { Clock } from "../clock/index.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolEntry } from "./types.js";

export class DynamicToolRegistrationOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `DynamicToolRegistrationOnPublicListener: SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION ` +
        `is set and listener binds to non-loopback host "${host}". Per §11.3.1 ` +
        `the dynamic-registration hook MUST NOT be reachable by untrusted principals.`
    );
    this.name = "DynamicToolRegistrationOnPublicListener";
  }
}

export function assertDynamicRegistrationListenerSafe(opts: {
  triggerPath: string | undefined;
  host: string;
}): void {
  if (!opts.triggerPath) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new DynamicToolRegistrationOnPublicListener(opts.host);
}

export interface DynamicWatcherOptions {
  triggerPath: string;
  registry: ToolRegistry;
  clock: Clock;
  /** Poll interval in milliseconds. Default 250ms — well below any test harness's wait. */
  pollIntervalMs?: number;
  /** Logger for operator visibility. */
  log?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export interface DynamicWatcherHandle {
  stop(): Promise<void>;
  /** Force one immediate poll cycle. Used by tests + operator tools. */
  tickNow(): Promise<number>;
}

/**
 * Start the watcher loop. Returns a handle with stop() + tickNow().
 * Safe to call even when the file doesn't yet exist — the watcher
 * treats ENOENT as "no-op this tick" and keeps polling.
 */
export function startDynamicRegistrationWatcher(
  opts: DynamicWatcherOptions
): DynamicWatcherHandle {
  const log = opts.log ?? ((msg) => console.log(msg));
  const onError =
    opts.onError ??
    ((err) => console.error(`[dynamic-registration] ${String(err)}`));
  const intervalMs = opts.pollIntervalMs ?? 250;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<number> {
    if (stopped) return 0;
    let raw: string;
    try {
      raw = await fsp.readFile(opts.triggerPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      onError(err);
      return 0;
    }
    if (raw.trim().length === 0) return 0;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      onError(err);
      // Truncate the file so a subsequent correct write can trigger ingestion.
      try {
        await fsp.writeFile(opts.triggerPath, "");
      } catch (truncErr) {
        onError(truncErr);
      }
      return 0;
    }

    if (!Array.isArray(parsed)) {
      onError(new Error("dynamic-registration trigger file MUST contain a JSON array of tool entries"));
      try {
        await fsp.writeFile(opts.triggerPath, "");
      } catch (truncErr) {
        onError(truncErr);
      }
      return 0;
    }

    let added = 0;
    const now = opts.clock();
    for (const entry of parsed) {
      try {
        if (opts.registry.addDynamic(entry as ToolEntry, now)) added++;
      } catch (err) {
        onError(err);
      }
    }

    // §11.3.1 truncate so the next write triggers another registration.
    try {
      await fsp.writeFile(opts.triggerPath, "");
    } catch (truncErr) {
      onError(truncErr);
    }
    if (added > 0) {
      log(`[dynamic-registration] ingested ${added} tool(s) from ${opts.triggerPath}`);
    }
    return added;
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } finally {
        schedule();
      }
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    tickNow: tick
  };
}
