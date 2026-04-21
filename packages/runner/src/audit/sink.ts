/**
 * §10.5.1 three-state audit-sink degradation machine.
 *
 *   healthy              — sink ship-acknowledged promptly; normal operation,
 *                          no events emitted
 *   degraded-buffering   — sink ship failed or timed out; buffer records to
 *                          `<sessionDir>/audit/pending/` (fsync-backed),
 *                          emit one AuditSinkDegraded event per transition,
 *                          /ready stays 200
 *   unreachable-halt     — sink has failed for > 60s OR buffer > 1000 records;
 *                          REFUSE any new Mutating/Destructive tool invocation
 *                          with PermissionDenied reason=audit-sink-unreachable,
 *                          permit ReadOnly, emit AuditSinkUnreachable, flip
 *                          /ready to 503 reason=audit-sink-unreachable
 *   recovery             — on sink return: flush buffer in order, verify the
 *                          external chain re-joins cleanly, emit AuditSink-
 *                          Recovered, return to healthy
 *
 * §12.5.2 test hook — SOA_RUNNER_AUDIT_SINK_FAILURE_MODE env var drives the
 * state deterministically (concrete side effects: real buffer writes, real
 * refusals). Fresh process boot with env set emits ONE matching AuditSink*
 * event at boot, treating the fresh process as an implicit `healthy` prior
 * transitioning to the named state (L-28 F-13 clarification).
 *
 * Production guard: refuse startup with the env var set when TLS binds to a
 * non-loopback host. Mirrors §10.6.1 clock-injection + §12.6 bootstrap-bearer
 * guards.
 */

import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { platform } from "node:os";
import type { Clock } from "../clock/index.js";
import type { RiskClass } from "../registry/types.js";
import type { AuditRecord } from "./chain.js";
import { NOOP_EMITTER, type MarkerEmitter } from "../markers/index.js";

const IS_WIN32 = platform() === "win32";

export type AuditSinkState = "healthy" | "degraded-buffering" | "unreachable-halt";

/** Closed-enum StreamEvent types emitted on state transitions. */
export type AuditSinkEventType =
  | "AuditSinkDegraded"
  | "AuditSinkUnreachable"
  | "AuditSinkRecovered";

/** One state-transition event — observed via /audit/sink-events (§12.5.4). */
export interface AuditSinkEvent {
  event_id: string; // `evt_<12 hex>` per schema
  type: AuditSinkEventType;
  transition_at: string; // RFC 3339
  detail: Record<string, unknown>;
}

export interface AuditSinkOptions {
  /**
   * Directory where the `/audit/pending/` queue lives. The sink creates
   * `<sessionDir>/audit/pending/` lazily on the first buffered write.
   */
  sessionDir: string;
  clock: Clock;
  /**
   * Optional initial state — applied at construction and emits one event
   * matching L-28 F-13 (fresh process with env hook set).
   */
  initialState?: AuditSinkState;
  /**
   * The env value, if any, that drove the initial state. Recorded in the
   * initial event's detail for operator visibility. Has no behavioral effect.
   */
  initialReason?: "env-test-hook" | "boot";
  /** §12.5.3 crash-test marker emitter. Defaults to no-op. */
  markers?: MarkerEmitter;
}

/** Production guard — refuse startup when the env hook is active on a public listener. */
export class AuditSinkOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `AuditSinkOnPublicListener: SOA_RUNNER_AUDIT_SINK_FAILURE_MODE is set and ` +
        `the listener binds to non-loopback host "${host}". Per §12.5.2 the ` +
        `failure-mode env hook MUST NOT be reachable by untrusted principals.`
    );
    this.name = "AuditSinkOnPublicListener";
  }
}

/**
 * §10.5.1 + §12.5.2 sink. Exposed in-process — routes consult it via
 * `shouldRefuseMutating()`, `readinessReason()`, `recordAuditRow()`.
 */
export class AuditSink {
  private state: AuditSinkState;
  private readonly events: AuditSinkEvent[] = [];
  private readonly buffer: AuditRecord[] = [];
  private readonly sessionDir: string;
  private readonly clock: Clock;
  private readonly markers: MarkerEmitter;
  private firstFailedAt: string | null = null;
  private unreachableSince: string | null = null;

  constructor(opts: AuditSinkOptions) {
    this.sessionDir = opts.sessionDir;
    this.clock = opts.clock;
    this.markers = opts.markers ?? NOOP_EMITTER;
    this.state = "healthy";
    if (opts.initialState && opts.initialState !== "healthy") {
      this.transitionTo(opts.initialState, opts.initialReason ?? "boot");
    } else if (opts.initialState === "healthy" && opts.initialReason === "env-test-hook") {
      // L-28 F-13 — the `healthy` env value also counts as an explicit-named
      // state. We don't emit an event for healthy (no transition type for it),
      // but we DO honor the env-hook reason for operator visibility.
      // Intentionally no event emission here per the event-type enum.
    }
  }

  currentState(): AuditSinkState {
    return this.state;
  }

  /** Snapshot of events for /audit/sink-events. Read-only; never mutates. */
  snapshotEvents(): readonly AuditSinkEvent[] {
    return this.events.slice();
  }

  /** True in unreachable-halt. Permissions-decisions route consults this. */
  shouldRefuseMutating(riskClass: RiskClass): boolean {
    if (this.state !== "unreachable-halt") return false;
    return riskClass === "Mutating" || riskClass === "Destructive";
  }

  /** Readiness reason override — §5.4 closed enum. */
  readinessReason(): "audit-sink-unreachable" | null {
    return this.state === "unreachable-halt" ? "audit-sink-unreachable" : null;
  }

  /**
   * Receive an audit record that was just appended to the in-memory chain.
   * In `healthy` it's a no-op (the chain already committed it). In
   * `degraded-buffering` it's written to the fsync-backed pending queue.
   * In `unreachable-halt` it's also buffered (the record already exists
   * in the chain by the time we get here; refusing to buffer would fork
   * local vs future-sink truth). Callers that want to enforce the halt
   * semantics MUST consult `shouldRefuseMutating()` BEFORE appending.
   */
  async recordAuditRow(record: AuditRecord): Promise<void> {
    if (this.state === "healthy") return;
    this.buffer.push(record);
    await this.writeBufferedRecord(record);
    // §12.5.3 — SOA_MARK_AUDIT_BUFFER_WRITE_DONE after the fsync-backed write.
    const recordId = typeof record["id"] === "string" ? (record["id"] as string) : record.this_hash;
    this.markers.auditBufferWriteDone(recordId);
  }

  /**
   * Force a state transition. Used by the env-hook boot path and by test
   * harnesses simulating network events. Emits AT MOST one event per call.
   */
  transitionTo(next: AuditSinkState, reason: string = "manual"): AuditSinkEvent | null {
    if (this.state === next) return null;

    const nowIso = this.clock().toISOString();
    const event_id = `evt_${randomBytes(6).toString("hex")}`;

    let event: AuditSinkEvent | null = null;
    if (next === "degraded-buffering") {
      this.firstFailedAt = nowIso;
      event = {
        event_id,
        type: "AuditSinkDegraded",
        transition_at: nowIso,
        detail: {
          first_failed_at: nowIso,
          buffered_records: this.buffer.length,
          reason
        }
      };
    } else if (next === "unreachable-halt") {
      this.unreachableSince = nowIso;
      event = {
        event_id,
        type: "AuditSinkUnreachable",
        transition_at: nowIso,
        detail: {
          unreachable_since: nowIso,
          buffered_records: this.buffer.length,
          reason
        }
      };
    } else if (next === "healthy") {
      // healthy is reached via recovery OR via initial-state env=healthy.
      if (this.state === "degraded-buffering" || this.state === "unreachable-halt") {
        event = {
          event_id,
          type: "AuditSinkRecovered",
          transition_at: nowIso,
          detail: {
            recovered_at: nowIso,
            flushed_records: this.buffer.length,
            reason
          }
        };
      }
    }

    if (event) this.events.push(event);
    this.state = next;
    if (next === "healthy") {
      this.firstFailedAt = null;
      this.unreachableSince = null;
    }
    return event;
  }

  /**
   * Drain the local buffer in order + transition back to healthy. Callers
   * (recovery path) supply a `shipRecord` fn that simulates sending to the
   * external sink. On success, emits AuditSinkRecovered and clears buffer.
   */
  async flushAndRecover(shipRecord: (r: AuditRecord) => Promise<void>): Promise<AuditSinkEvent | null> {
    const snapshot = this.buffer.slice();
    const flushedCount = snapshot.length;
    for (const r of snapshot) {
      await shipRecord(r);
    }
    this.buffer.length = 0;
    await this.clearPendingDir();

    // Emit the recovery event with the pre-flush record count. transitionTo's
    // default detail would see an empty buffer (we just cleared it), so
    // build the event here and swap it in.
    const event = this.transitionTo("healthy", "sink-recovered");
    if (event) {
      (event.detail as Record<string, unknown>)["flushed_records"] = flushedCount;
    }
    return event;
  }

  /**
   * Diagnostic — how many records sit in the in-memory buffer right now.
   * /audit/sink-events exposes this in event details, not here directly.
   */
  bufferedCount(): number {
    return this.buffer.length;
  }

  firstFailedAtIso(): string | null {
    return this.firstFailedAt;
  }

  unreachableSinceIso(): string | null {
    return this.unreachableSince;
  }

  // ---- internals --------------------------------------------------------

  private pendingDir(): string {
    return join(this.sessionDir, "audit", "pending");
  }

  private async writeBufferedRecord(record: AuditRecord): Promise<void> {
    const dir = this.pendingDir();
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${record.this_hash}.json`;
    const finalPath = join(dir, filename);
    const tmpPath = `${finalPath}.tmp.${randomBytes(4).toString("hex")}`;
    const bytes = Buffer.from(JSON.stringify(record));
    const fh = await fsp.open(tmpPath, "w", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync(); // §12.3 fsync boundary
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, finalPath);
    if (!IS_WIN32) {
      const dirFh = await fsp.open(dir, "r");
      try {
        try {
          await dirFh.sync();
        } catch (err) {
          // POSIX-branch no-op on Win32 hosts during test simulation.
          if (!(IS_WIN32 && (err as NodeJS.ErrnoException).code === "EPERM")) throw err;
        }
      } finally {
        await dirFh.close();
      }
    } else {
      const finalFh = await fsp.open(finalPath, "r+");
      try {
        await finalFh.sync();
      } finally {
        await finalFh.close();
      }
    }
  }

  private async clearPendingDir(): Promise<void> {
    const dir = this.pendingDir();
    try {
      const entries = await fsp.readdir(dir);
      for (const e of entries) {
        if (e.endsWith(".json")) await fsp.unlink(join(dir, e)).catch(() => undefined);
      }
    } catch (err) {
      // Directory may not exist — no-op.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** §12.5.2 env-var parser. Returns null when the env is unset. */
export function parseAuditSinkFailureModeEnv(value: string | undefined): AuditSinkState | null {
  if (!value) return null;
  if (value === "healthy" || value === "degraded-buffering" || value === "unreachable-halt") {
    return value;
  }
  throw new Error(
    `SOA_RUNNER_AUDIT_SINK_FAILURE_MODE has invalid value "${value}"; ` +
      `must be one of healthy | degraded-buffering | unreachable-halt`
  );
}

/**
 * §12.5.2 production guard. Refuse startup when the failure-mode env hook is
 * set AND the listener binds a non-loopback host. Loopback-only = test/demo.
 * Mirrors the semantics of `assertBootstrapBearerListenerSafe`.
 */
export function assertAuditSinkEnvListenerSafe(opts: {
  envValue: string | undefined;
  host: string;
}): void {
  if (!opts.envValue) return;
  const host = opts.host.toLowerCase();
  // Match the bootstrap-bearer-listener guard: 0.0.0.0 counts as non-loopback
  // (a DNS name resolving to the internet is indistinguishable to the guard).
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) {
    throw new AuditSinkOnPublicListener(opts.host);
  }
}
