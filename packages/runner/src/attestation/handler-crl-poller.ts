/**
 * §10.6 / §10.6.2 L-48 — Handler CRL refresh poller.
 *
 * Complements the bootstrap RevocationPoller (§5.3.3 AQ) by watching
 * the same SOA_BOOTSTRAP_REVOCATION_FILE for entries keyed by
 * `handler_kid`. Non-terminal: a handler revocation flags one kid
 * without halting the Runner. Each successful refresh records a
 * `crl-refresh-complete` row on /logs/system/recent under
 * BOOT_SESSION_ID per SV-PERM-14.
 *
 * Default tick 60 minutes per §10.6. Validators override via
 * RUNNER_HANDLER_CRL_POLL_TICK_MS — typically 100ms so SV-PERM-09
 * observes revocation propagation within a test window.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Clock } from "../clock/index.js";
import type { SystemLogBuffer } from "../system-log/index.js";
import type { HandlerKeyRegistry } from "./handler-key.js";

export interface HandlerRevocationFileEntry {
  handler_kid?: string;
  publisher_kid?: string;
  reason?: string;
  revoked_at?: string;
}

export interface HandlerCrlPollerOptions {
  filePath: string;
  registry: HandlerKeyRegistry;
  tickMs: number;
  clock: Clock;
  systemLog?: SystemLogBuffer;
  bootSessionId?: string;
  /**
   * Fires when a handler kid is newly revoked. Callers hook this to
   * trigger the §10.6.5 retroactive SuspectDecision flagging pass
   * (Finding BE-retroactive). Receives the kid + normalized record.
   */
  onHandlerRevoked?: (kid: string, record: HandlerRevocationFileEntry) => void;
  log?: (msg: string) => void;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class HandlerCrlPoller {
  private readonly filePath: string;
  private readonly registry: HandlerKeyRegistry;
  private readonly tickMs: number;
  private readonly clock: Clock;
  private readonly systemLog: SystemLogBuffer | undefined;
  private readonly bootSessionId: string | undefined;
  private readonly onHandlerRevoked:
    | ((kid: string, record: HandlerRevocationFileEntry) => void)
    | undefined;
  private readonly log: (msg: string) => void;
  private readonly setIntervalFn: NonNullable<HandlerCrlPollerOptions["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<HandlerCrlPollerOptions["clearInterval"]>;

  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HandlerCrlPollerOptions) {
    this.filePath = opts.filePath;
    this.registry = opts.registry;
    this.tickMs = opts.tickMs;
    this.clock = opts.clock;
    this.systemLog = opts.systemLog;
    this.bootSessionId = opts.bootSessionId;
    this.onHandlerRevoked = opts.onHandlerRevoked;
    this.log = opts.log ?? ((m) => console.log(m));
    this.setIntervalFn = opts.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalFn(() => this.tick(), this.tickMs);
    const h = this.handle as unknown as { unref?: () => void };
    if (typeof h.unref === "function") h.unref();
  }

  stop(): void {
    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  /**
   * One poll tick. Reads the revocation file (if present), picks up
   * any handler_kid entries not yet recorded, revokes each in the
   * registry, fires onHandlerRevoked, and always records a
   * crl-refresh-complete log row (even when the file is absent — the
   * refresh attempt itself is the observability event per §10.6.2).
   */
  tick(): void {
    const nowIso = this.clock().toISOString();
    let record: HandlerRevocationFileEntry | null = null;
    if (existsSync(this.filePath)) {
      try {
        record = JSON.parse(readFileSync(this.filePath, "utf8")) as HandlerRevocationFileEntry;
      } catch (err) {
        this.log(
          `[handler-crl] failed to parse ${this.filePath}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }

    if (record !== null && typeof record.handler_kid === "string" && record.handler_kid.length > 0) {
      const kid = record.handler_kid;
      if (!this.registry.isRevoked(kid)) {
        const revokedAt = record.revoked_at ?? nowIso;
        const reason = record.reason ?? "unspecified";
        this.registry.revoke(kid, revokedAt, reason);
        if (this.onHandlerRevoked !== undefined) this.onHandlerRevoked(kid, record);
        this.log(`[handler-crl] revocation observed for handler_kid=${kid} reason=${reason}`);
      }
    }

    this.registry.recordCrlRefresh(nowIso);
    if (this.systemLog !== undefined && this.bootSessionId !== undefined) {
      this.systemLog.write({
        session_id: this.bootSessionId,
        category: "Config",
        level: "info",
        code: "crl-refresh-complete",
        message: `Handler CRL refresh tick completed`,
        data: {
          last_crl_refresh_at: nowIso,
          tick_ms: this.tickMs,
          revoked_count: this.registry.kids().filter((k) => this.registry.isRevoked(k)).length
        }
      });
    }
  }
}
