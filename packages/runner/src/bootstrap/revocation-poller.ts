/**
 * §5.3.1 / Finding AQ — revocation-file poller (SV-BOOT-04).
 *
 * When `SOA_BOOTSTRAP_REVOCATION_FILE` is configured, the Runner
 * polls the given file at `RUNNER_BOOTSTRAP_POLL_TICK_MS` cadence.
 * Presence of the file with a matching `publisher_kid` triggers the
 * §5.3.1 revocation path — the poller invokes the caller-supplied
 * onRevoked callback exactly once. Subsequent ticks do not re-invoke
 * (revocation is a terminal state).
 *
 * The poller is stateless about its own running status apart from the
 * terminal flag; start/stop are idempotent. Timers are `.unref()`'d
 * so the scheduler never prolongs the process lifetime.
 */

import { existsSync, readFileSync } from "node:fs";

export interface RevocationRecord {
  publisher_kid: string;
  reason?: string;
  revoked_at?: string;
}

export interface RevocationPollerOptions {
  filePath: string;
  expectedPublisherKid: string;
  tickMs: number;
  onRevoked: (record: RevocationRecord) => void;
  log?: (msg: string) => void;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class RevocationPoller {
  private readonly filePath: string;
  private readonly expectedPublisherKid: string;
  private readonly tickMs: number;
  private readonly onRevoked: (record: RevocationRecord) => void;
  private readonly log: (msg: string) => void;
  private readonly setIntervalFn: Required<RevocationPollerOptions>["setInterval"];
  private readonly clearIntervalFn: Required<RevocationPollerOptions>["clearInterval"];

  private handle: ReturnType<typeof setInterval> | null = null;
  private revoked = false;

  constructor(opts: RevocationPollerOptions) {
    this.filePath = opts.filePath;
    this.expectedPublisherKid = opts.expectedPublisherKid;
    this.tickMs = opts.tickMs;
    this.onRevoked = opts.onRevoked;
    this.log = opts.log ?? ((m) => console.log(m));
    this.setIntervalFn = opts.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h));
  }

  start(): void {
    if (this.handle !== null || this.revoked) return;
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

  /** Force one tick synchronously — used by tests + dev tooling. */
  tick(): void {
    if (this.revoked) return;
    if (!existsSync(this.filePath)) return;
    let record: RevocationRecord;
    try {
      record = JSON.parse(readFileSync(this.filePath, "utf8")) as RevocationRecord;
    } catch (err) {
      this.log(
        `[bootstrap-revocation] failed to parse ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    if (record.publisher_kid !== this.expectedPublisherKid) {
      this.log(
        `[bootstrap-revocation] file carries publisher_kid=${record.publisher_kid} — ` +
          `expected ${this.expectedPublisherKid}; ignoring`
      );
      return;
    }
    this.revoked = true;
    this.stop();
    this.onRevoked(record);
  }

  isRevoked(): boolean {
    return this.revoked;
  }
}
