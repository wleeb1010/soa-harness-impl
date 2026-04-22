/**
 * §8.4 Memory consolidation scheduler (Finding U / SV-MEM-05).
 *
 * §8.4 line 595: "consolidate_memories invoked at least once per 24
 * hours OR after any session accumulating ≥ 100 new notes."
 *
 * The scheduler runs in-process alongside the Memory MCP client. Two
 * trigger conditions, whichever fires first:
 *
 *   1. Elapsed-time trigger: 24 h (default) since the last successful
 *      consolidate_memories call. An in-memory timer ticks every
 *      `tickIntervalMs` (default 5 min) and fires the consolidation
 *      when the elapsed clock crosses the 24 h threshold.
 *   2. Note-count trigger: any session's per-session note counter
 *      reaches `noteCountThreshold` (default 100). When the Runner
 *      records a write_memory for session S, the counter advances;
 *      crossing the threshold fires consolidation IMMEDIATELY and
 *      resets S's counter to 0.
 *
 * On every consolidation attempt (success, error, or timeout), the
 * scheduler writes a System Event Log record so /logs/system/recent
 * surfaces the trigger trail.
 *
 *   success: category=ContextLoad, level=info,  code=consolidation-ran
 *   failure: category=Error,       level=error, code=consolidation-failed
 *
 * In M3 there is no real LLM write-memory dispatch, so recordNoteWritten()
 * has no internal caller — the public API exists so the validator can
 * drive it via test harnesses OR a future M4 dispatcher can wire it
 * up without another impl change. The 24 h elapsed-time trigger fires
 * regardless, which is what SV-MEM-05's live-path probe exercises.
 */

import type { MemoryMcpClient } from "./mcp-client.js";
import type { SystemLogBuffer } from "../system-log/index.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_NOTE_COUNT_THRESHOLD = 100;
const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_BOOT_SESSION_ID = "ses_runner_boot_____";

export interface ConsolidationSchedulerOptions {
  client: MemoryMcpClient;
  systemLog?: SystemLogBuffer;
  /** Wall-clock milliseconds between consolidation runs. Default 24 h. */
  intervalMs?: number;
  /** Per-session note-count threshold. Default 100. */
  noteCountThreshold?: number;
  /** How often to check the elapsed clock. Default 5 min. */
  tickIntervalMs?: number;
  /** Synthetic session_id for log records that aren't session-owned. */
  bootSessionId?: string;
  clock: () => Date;
  /** Logger for operator visibility. */
  log?: (msg: string) => void;
  /**
   * Injected setInterval/setTimeout hooks for test isolation. Defaults
   * to the built-in timer APIs; tests pass fakes so they don't depend
   * on wall-clock advancement.
   */
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface ConsolidationOutcome {
  trigger: "elapsed" | "note-count" | "manual";
  consolidated_count: number;
  pending_count: number;
  ran_at: string;
}

export class ConsolidationScheduler {
  private readonly client: MemoryMcpClient;
  private readonly systemLog: SystemLogBuffer | undefined;
  private readonly intervalMs: number;
  private readonly noteCountThreshold: number;
  private readonly tickIntervalMs: number;
  private readonly bootSessionId: string;
  private readonly clock: () => Date;
  private readonly log: (msg: string) => void;
  private readonly setIntervalFn: ConsolidationSchedulerOptions["setInterval"];
  private readonly clearIntervalFn: ConsolidationSchedulerOptions["clearInterval"];

  private readonly noteCounts = new Map<string, number>();
  private lastRunAt: Date;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private outcomes: ConsolidationOutcome[] = [];

  constructor(opts: ConsolidationSchedulerOptions) {
    this.client = opts.client;
    this.systemLog = opts.systemLog;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.noteCountThreshold = opts.noteCountThreshold ?? DEFAULT_NOTE_COUNT_THRESHOLD;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.bootSessionId = opts.bootSessionId ?? DEFAULT_BOOT_SESSION_ID;
    this.clock = opts.clock;
    this.log = opts.log ?? ((m) => console.log(m));
    this.setIntervalFn = opts.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
    this.lastRunAt = this.clock();
  }

  /**
   * Start the background tick loop. Safe to call once per process.
   * Second calls are a no-op (handle already set).
   */
  start(): void {
    if (this.tickHandle !== null) return;
    const tick = (): void => {
      void this.maybeFireElapsed();
    };
    this.tickHandle = this.setIntervalFn!(tick, this.tickIntervalMs);
    // node's setInterval returns an object with .unref() so the timer
    // doesn't keep the process alive past normal shutdown signals.
    const h = this.tickHandle as unknown as { unref?: () => void };
    if (typeof h.unref === "function") h.unref();
  }

  /** Stop the background loop. Idempotent. */
  stop(): void {
    if (this.tickHandle !== null) {
      this.clearIntervalFn!(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Called on every successful write_memory dispatch. Advances the
   * per-session counter; when the threshold is crossed, fires
   * consolidation IMMEDIATELY (not on the next tick) and resets the
   * counter. Safe to call when the scheduler has been stopped — the
   * counter still advances, the consolidation still runs.
   */
  async recordNoteWritten(session_id: string): Promise<ConsolidationOutcome | null> {
    const next = (this.noteCounts.get(session_id) ?? 0) + 1;
    this.noteCounts.set(session_id, next);
    if (next >= this.noteCountThreshold) {
      this.noteCounts.set(session_id, 0);
      return await this.fire("note-count", session_id);
    }
    return null;
  }

  /**
   * Force a consolidation run regardless of elapsed time / note count.
   * Used by tests + operator tools; equivalent to a cron-initiated
   * trigger.
   */
  async runNow(sessionIdHint?: string): Promise<ConsolidationOutcome> {
    return await this.fire("manual", sessionIdHint ?? this.bootSessionId);
  }

  /** Test probe — current per-session note counts. */
  snapshotCounts(): ReadonlyMap<string, number> {
    return new Map(this.noteCounts);
  }

  /** Test probe — outcomes recorded so far. */
  outcomesSnapshot(): readonly ConsolidationOutcome[] {
    return this.outcomes.slice();
  }

  /** Test probe — when the scheduler last ran consolidation. */
  lastRunIso(): string {
    return this.lastRunAt.toISOString();
  }

  private async maybeFireElapsed(): Promise<void> {
    const now = this.clock();
    if (now.getTime() - this.lastRunAt.getTime() >= this.intervalMs) {
      await this.fire("elapsed", this.bootSessionId);
    }
  }

  private async fire(
    trigger: ConsolidationOutcome["trigger"],
    sessionIdForLog: string
  ): Promise<ConsolidationOutcome> {
    const ranAt = this.clock();
    try {
      const result = await this.client.consolidateMemories();
      this.lastRunAt = ranAt;
      const outcome: ConsolidationOutcome = {
        trigger,
        consolidated_count: result.consolidated_count,
        pending_count: result.pending_count,
        ran_at: ranAt.toISOString()
      };
      this.outcomes.push(outcome);
      this.log(
        `[consolidation] trigger=${trigger} consolidated=${result.consolidated_count} pending=${result.pending_count}`
      );
      if (this.systemLog) {
        this.systemLog.write({
          session_id: sessionIdForLog,
          category: "ContextLoad",
          level: "info",
          code: "consolidation-ran",
          message: `Memory consolidation ran (trigger=${trigger}, consolidated=${result.consolidated_count}, pending=${result.pending_count})`,
          data: {
            trigger,
            consolidated_count: result.consolidated_count,
            pending_count: result.pending_count
          }
        });
      }
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[consolidation] FAILED trigger=${trigger}: ${msg}`);
      if (this.systemLog) {
        this.systemLog.write({
          session_id: sessionIdForLog,
          category: "Error",
          level: "error",
          code: "consolidation-failed",
          message: `Memory consolidation failed (trigger=${trigger}): ${msg}`,
          data: { trigger, error: msg }
        });
      }
      // Return a failure outcome — lastRunAt is NOT updated so the
      // next tick retries promptly instead of waiting another 24h.
      const outcome: ConsolidationOutcome = {
        trigger,
        consolidated_count: 0,
        pending_count: 0,
        ran_at: ranAt.toISOString()
      };
      return outcome;
    }
  }
}
