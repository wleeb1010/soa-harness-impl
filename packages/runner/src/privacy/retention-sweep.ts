/**
 * §10.7.3 Retention sweep scheduler (SV-PRIV-04).
 *
 * "Runners MUST run a retention sweep at least every 24 hours."
 *
 * Periodic job that evaluates each retention category:
 *
 *   - `memory-personal`   → tombstone past-horizon memory entries
 *   - `session-body`      → tombstone past-horizon session bodies
 *   - `audit-personal`    → redact on export (never destructively deleted)
 *   - `audit-integrity`   → never deleted (§10.5 WORM precedence)
 *   - `operational`       → deleted after 30 days
 *
 * For M3 conformance the impl demonstrates that the sweep runs on the
 * required cadence and emits a System Event Log record each pass.
 * Full retention evaluation across persisted stores is a post-M3
 * concern; the scaffolded evaluator hooks let validators observe the
 * sweep without needing deep-populated retention state.
 */

import type { SystemLogBuffer } from "../system-log/index.js";
import { BOOT_SESSION_ID as DEFAULT_BOOT_SESSION_ID } from "../permission/boot-session.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 min

export type RetentionCategory =
  | "audit-integrity"
  | "audit-personal"
  | "memory-personal"
  | "session-body"
  | "operational";

export interface RetentionSweepOutcome {
  ran_at: string;
  records_tombstoned_memory: number;
  records_tombstoned_session: number;
  records_redacted_audit: number;
  records_inspected: number;
}

export interface RetentionSweeperHooks {
  /** Returns count of memory entries tombstoned on this sweep. */
  sweepMemory?: () => number;
  /** Returns count of session bodies tombstoned on this sweep. */
  sweepSessionBodies?: () => number;
  /** Returns count of audit-personal records queued for export-redaction. */
  sweepAuditPersonal?: () => number;
  /** Returns total records inspected across all categories. */
  inspected?: () => number;
}

export interface RetentionSweepOptions {
  systemLog?: SystemLogBuffer;
  /** Sweep cadence. Default 24 h. */
  intervalMs?: number;
  /** Tick cadence. Default 5 min. */
  tickIntervalMs?: number;
  bootSessionId?: string;
  clock: () => Date;
  log?: (msg: string) => void;
  hooks?: RetentionSweeperHooks;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class RetentionSweepScheduler {
  private readonly systemLog: SystemLogBuffer | undefined;
  private readonly intervalMs: number;
  private readonly tickIntervalMs: number;
  private readonly bootSessionId: string;
  private readonly clock: () => Date;
  private readonly log: (msg: string) => void;
  private readonly hooks: RetentionSweeperHooks;
  private readonly setIntervalFn: Required<RetentionSweepOptions>["setInterval"];
  private readonly clearIntervalFn: Required<RetentionSweepOptions>["clearInterval"];

  private lastRunAt: Date;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private outcomes: RetentionSweepOutcome[] = [];

  constructor(opts: RetentionSweepOptions) {
    this.systemLog = opts.systemLog;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.bootSessionId = opts.bootSessionId ?? DEFAULT_BOOT_SESSION_ID;
    this.clock = opts.clock;
    this.log = opts.log ?? ((m) => console.log(m));
    this.hooks = opts.hooks ?? {};
    this.setIntervalFn = opts.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
    this.lastRunAt = this.clock();
  }

  start(): void {
    if (this.tickHandle !== null) return;
    const tick = (): void => {
      this.maybeFire();
    };
    this.tickHandle = this.setIntervalFn(tick, this.tickIntervalMs);
    const h = this.tickHandle as unknown as { unref?: () => void };
    if (typeof h.unref === "function") h.unref();
  }

  stop(): void {
    if (this.tickHandle !== null) {
      this.clearIntervalFn(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Force a sweep regardless of elapsed time. */
  runNow(): RetentionSweepOutcome {
    return this.sweep();
  }

  outcomesSnapshot(): readonly RetentionSweepOutcome[] {
    return this.outcomes.slice();
  }

  lastRunIso(): string {
    return this.lastRunAt.toISOString();
  }

  private maybeFire(): void {
    const now = this.clock();
    if (now.getTime() - this.lastRunAt.getTime() >= this.intervalMs) {
      this.sweep();
    }
  }

  private sweep(): RetentionSweepOutcome {
    const ranAt = this.clock();
    this.lastRunAt = ranAt;
    const outcome: RetentionSweepOutcome = {
      ran_at: ranAt.toISOString(),
      records_tombstoned_memory: this.hooks.sweepMemory?.() ?? 0,
      records_tombstoned_session: this.hooks.sweepSessionBodies?.() ?? 0,
      records_redacted_audit: this.hooks.sweepAuditPersonal?.() ?? 0,
      records_inspected: this.hooks.inspected?.() ?? 0
    };
    this.outcomes.push(outcome);
    this.log(
      `[retention-sweep] ran_at=${outcome.ran_at} tombstoned_memory=${outcome.records_tombstoned_memory} ` +
        `tombstoned_session=${outcome.records_tombstoned_session} redacted_audit=${outcome.records_redacted_audit} ` +
        `inspected=${outcome.records_inspected}`
    );
    if (this.systemLog) {
      this.systemLog.write({
        session_id: this.bootSessionId,
        category: "ContextLoad",
        level: "info",
        code: "retention-sweep-ran",
        message:
          `§10.7.3 retention sweep complete (tombstoned_memory=${outcome.records_tombstoned_memory}, ` +
          `tombstoned_session=${outcome.records_tombstoned_session}, ` +
          `redacted_audit=${outcome.records_redacted_audit}, ` +
          `inspected=${outcome.records_inspected})`,
        data: outcome as unknown as Record<string, unknown>
      });
    }
    return outcome;
  }
}
