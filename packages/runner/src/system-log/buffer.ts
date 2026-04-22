/**
 * §14.2 System Event Log + §14.5.4 /logs/system/recent polling surface.
 *
 * The System Event Log is a JSON-Lines buffer the Runner uses to record
 * non-decision lifecycle events (memory degradation, permission
 * transitions, config reloads, routing errors, etc.). Unlike the §10.5
 * audit chain, system log records don't form a hash chain — they're
 * operational observability, not a durability surface. Unlike the
 * §14.1 StreamEvent buffer, they're category-filtered and carry a
 * level (info/warn/error) for log-severity routing.
 *
 * Record shape (§14.5.4 pinned):
 *   record_id    slog_ + 12 hex
 *   ts           RFC-3339 UTC timestamp
 *   session_id   session this record belongs to
 *   category     closed enum of 12 values
 *   level        info | warn | error
 *   code         operator-meaningful code string (e.g., "memory-timeout")
 *   message      human-readable, maxLength 1024
 *   data         optional structured payload
 *
 * Scope: per-session ring buffer bounded at maxRecordsPerSession
 * (default 1000, FIFO). Cross-session aggregation lands in M4 if
 * validators ask for it.
 *
 * NOT-A-SIDE-EFFECT: snapshot() returns a defensive copy; reads never
 * advance any counter or alter retention.
 */

import { randomBytes } from "node:crypto";
import type { Clock } from "../clock/index.js";

/** §14.5.4 closed enum — adding a value is a spec change. */
export const SYSTEM_LOG_CATEGORIES = [
  "ContextLoad",
  "MemoryLoad",
  "MemoryDegraded",
  "Permission",
  "Routing",
  "Config",
  "Card",
  "SelfImprovement",
  "Audit",
  "Budget",
  "Handoff",
  "Error"
] as const;

export type SystemLogCategory = (typeof SYSTEM_LOG_CATEGORIES)[number];

const SYSTEM_LOG_CATEGORY_SET: ReadonlySet<string> = new Set<string>(SYSTEM_LOG_CATEGORIES);

export function isSystemLogCategory(value: unknown): value is SystemLogCategory {
  return typeof value === "string" && SYSTEM_LOG_CATEGORY_SET.has(value);
}

export class SystemLogCategoryInvalid extends Error {
  readonly attempted: string;
  constructor(category: string) {
    super(
      `SystemLogCategory "${category}" is not in the §14.5.4 closed 12-value enum.`
    );
    this.name = "SystemLogCategoryInvalid";
    this.attempted = category;
  }
}

export type SystemLogLevel = "info" | "warn" | "error";

export interface SystemLogRecord {
  record_id: string;
  ts: string;
  session_id: string;
  category: SystemLogCategory;
  level: SystemLogLevel;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SystemLogWriteParams {
  session_id: string;
  category: SystemLogCategory | string;
  level: SystemLogLevel;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SystemLogBufferOptions {
  clock: Clock;
  maxRecordsPerSession?: number;
}

export class SystemLogBuffer {
  private readonly records = new Map<string, SystemLogRecord[]>();
  private readonly maxPerSession: number;
  private readonly clock: Clock;

  constructor(opts: SystemLogBufferOptions) {
    this.clock = opts.clock;
    this.maxPerSession = opts.maxRecordsPerSession ?? 1000;
  }

  /** Write a record. Throws SystemLogCategoryInvalid on non-enum category. */
  write(params: SystemLogWriteParams): SystemLogRecord {
    if (!SYSTEM_LOG_CATEGORY_SET.has(params.category)) {
      throw new SystemLogCategoryInvalid(params.category);
    }
    const record: SystemLogRecord = {
      record_id: `slog_${randomBytes(6).toString("hex")}`,
      ts: this.clock().toISOString(),
      session_id: params.session_id,
      category: params.category as SystemLogCategory,
      level: params.level,
      code: params.code,
      message: params.message.length > 1024 ? params.message.slice(0, 1024) : params.message,
      ...(params.data !== undefined ? { data: params.data } : {})
    };
    const arr = this.records.get(params.session_id) ?? [];
    arr.push(record);
    if (arr.length > this.maxPerSession) arr.shift();
    this.records.set(params.session_id, arr);
    return record;
  }

  /**
   * Session-scoped read with optional category filter. Reads are
   * NOT-A-SIDE-EFFECT; `categories` filters in-memory without mutating.
   */
  snapshot(
    session_id: string,
    categories?: ReadonlySet<SystemLogCategory>
  ): readonly SystemLogRecord[] {
    const arr = (this.records.get(session_id) ?? []).slice();
    if (categories === undefined || categories.size === 0) return arr;
    return arr.filter((r) => categories.has(r.category));
  }

  countAll(): number {
    let n = 0;
    for (const arr of this.records.values()) n += arr.length;
    return n;
  }
}
