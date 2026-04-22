/**
 * §12.5.3 Crash-Test Markers.
 *
 * When `RUNNER_CRASH_TEST_MARKERS=1` is set, the Runner emits structured
 * marker lines to stderr at each significant §12.2 / §12.3 / §10.5 boundary.
 * Validator crash-kill harnesses (soa-validate V2-04) use these markers to
 * name the exact fsync boundary to kill at, making HR-04/HR-05 /
 * SV-SESS-03/04/06/07/10 deterministic across impls.
 *
 * Production guard: the env var MUST NOT be enabled when the listener binds
 * a non-loopback host. The stderr stream could leak session identifiers to
 * log aggregators that don't carry the required confidentiality controls.
 * Mirrors §10.6.1 clock-injection + §12.5.2 sink-failure-mode guard.
 *
 * Cross-platform identity: the markers fire in the same logical order on
 * Linux, macOS, and Windows for equivalent workflow paths. Platform mechanics
 * (POSIX fsync vs FlushFileBuffers+MoveFileEx) are abstracted behind
 * SOA_MARK_DIR_FSYNC_DONE.
 */

/** Closed enum of marker names §12.5.3 defines. Extending is a spec change. */
export type CrashTestMarker =
  | "SOA_MARK_PENDING_WRITE_DONE"
  | "SOA_MARK_TOOL_INVOKE_START"
  | "SOA_MARK_TOOL_INVOKE_DONE"
  | "SOA_MARK_COMMITTED_WRITE_DONE"
  | "SOA_MARK_DIR_FSYNC_DONE"
  | "SOA_MARK_AUDIT_APPEND_DONE"
  | "SOA_MARK_AUDIT_BUFFER_WRITE_DONE";

/** Production guard — refuse startup when the markers env is active on a public listener. */
export class CrashTestMarkersOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `CrashTestMarkersOnPublicListener: RUNNER_CRASH_TEST_MARKERS=1 and the ` +
        `listener binds to non-loopback host "${host}". Per §12.5.3 the marker ` +
        `env var MUST NOT be enabled in production — stderr marker lines can ` +
        `leak session identifiers to untrusted log aggregators.`
    );
    this.name = "CrashTestMarkersOnPublicListener";
  }
}

export interface MarkerEmitterOptions {
  /** Whether emission is enabled. Driven from RUNNER_CRASH_TEST_MARKERS=1. */
  enabled: boolean;
  /**
   * Override the stderr stream for tests. Defaults to `process.stderr.write`.
   * The emitter writes one newline-terminated line per marker.
   */
  write?: (line: string) => void;
  /**
   * §12.5.3 L-51 Finding AE — crash-after-marker kill trigger.
   * When set to one of the §12.5.3 marker names, the emitter issues a
   * SIGKILL against its own PID immediately after writing that marker
   * line. Used by SV-STR-10 validator harness to pin the kill at a
   * deterministic on-disk state (typically SOA_MARK_PENDING_WRITE_DONE
   * so boot-scan resume + CrashEvent emission are observable on
   * restart). Loopback-guarded alongside RUNNER_CRASH_TEST_MARKERS.
   */
  crashAfter?: CrashTestMarker;
  /** Override the self-kill for tests. Defaults to process.kill(pid, 'SIGKILL'). */
  killSelf?: () => void;
}

/**
 * In-process marker emitter. No-op when `enabled` is false.
 *
 * Line format: `<MARKER_NAME> key1=value1 key2=value2 ...\n`
 * Keys are emitted in a fixed order per marker type for cross-platform
 * identity. Values are coerced to strings; callers MUST NOT pass arbitrary
 * user-controlled data (session_id pattern is validated upstream).
 */
export class MarkerEmitter {
  private readonly enabled: boolean;
  private readonly write: (line: string) => void;
  private readonly crashAfter: CrashTestMarker | undefined;
  private readonly killSelf: () => void;
  private killed = false;

  constructor(opts: MarkerEmitterOptions) {
    this.enabled = opts.enabled;
    this.write = opts.write ?? ((line) => process.stderr.write(line));
    this.crashAfter = opts.crashAfter;
    this.killSelf =
      opts.killSelf ??
      (() => {
        // SIGKILL models a hard process death — no cleanup runs, which is
        // exactly what SV-STR-10 needs to prove boot-scan resume works
        // against a genuinely-abandoned file. On Windows SIGKILL is
        // translated into TerminateProcess semantics which is equivalent.
        process.kill(process.pid, "SIGKILL");
      });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private maybeCrash(marker: CrashTestMarker): void {
    if (this.crashAfter !== marker || this.killed) return;
    this.killed = true;
    this.killSelf();
  }

  pendingWriteDone(session_id: string, side_effect: number): void {
    if (!this.enabled) return;
    this.write(
      `SOA_MARK_PENDING_WRITE_DONE session_id=${session_id} side_effect=${side_effect}\n`
    );
    this.maybeCrash("SOA_MARK_PENDING_WRITE_DONE");
  }

  toolInvokeStart(session_id: string, side_effect: number): void {
    if (!this.enabled) return;
    this.write(
      `SOA_MARK_TOOL_INVOKE_START session_id=${session_id} side_effect=${side_effect}\n`
    );
    this.maybeCrash("SOA_MARK_TOOL_INVOKE_START");
  }

  toolInvokeDone(
    session_id: string,
    side_effect: number,
    result: "committed" | "compensated"
  ): void {
    if (!this.enabled) return;
    this.write(
      `SOA_MARK_TOOL_INVOKE_DONE session_id=${session_id} side_effect=${side_effect} result=${result}\n`
    );
    this.maybeCrash("SOA_MARK_TOOL_INVOKE_DONE");
  }

  committedWriteDone(session_id: string, side_effect: number): void {
    if (!this.enabled) return;
    this.write(
      `SOA_MARK_COMMITTED_WRITE_DONE session_id=${session_id} side_effect=${side_effect}\n`
    );
    this.maybeCrash("SOA_MARK_COMMITTED_WRITE_DONE");
  }

  dirFsyncDone(session_id: string): void {
    if (!this.enabled) return;
    this.write(`SOA_MARK_DIR_FSYNC_DONE session_id=${session_id}\n`);
    this.maybeCrash("SOA_MARK_DIR_FSYNC_DONE");
  }

  auditAppendDone(audit_record_id: string): void {
    if (!this.enabled) return;
    this.write(`SOA_MARK_AUDIT_APPEND_DONE audit_record_id=${audit_record_id}\n`);
    this.maybeCrash("SOA_MARK_AUDIT_APPEND_DONE");
  }

  auditBufferWriteDone(audit_record_id: string): void {
    if (!this.enabled) return;
    this.write(`SOA_MARK_AUDIT_BUFFER_WRITE_DONE audit_record_id=${audit_record_id}\n`);
    this.maybeCrash("SOA_MARK_AUDIT_BUFFER_WRITE_DONE");
  }
}

/** Shared no-op instance for callers who don't care about emission. */
export const NOOP_EMITTER = new MarkerEmitter({ enabled: false });

/**
 * §12.5.3 production guard. Refuse startup with RUNNER_CRASH_TEST_MARKERS=1
 * set AND non-loopback bind. Loopback set: 127.0.0.1 / ::1 / localhost.
 * 0.0.0.0 counts as non-loopback (matches bootstrap-bearer-guard precedent).
 */
export function assertCrashTestMarkersListenerSafe(opts: {
  enabled: boolean;
  host: string;
}): void {
  if (!opts.enabled) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) {
    throw new CrashTestMarkersOnPublicListener(opts.host);
  }
}

/** Parse the env var value into a boolean. Only "1" enables; everything else disables. */
export function parseCrashTestMarkersEnv(value: string | undefined): boolean {
  return value === "1";
}

/** Allowed marker-name values for the crash-after-marker env hook. */
const CRASH_AFTER_MARKERS: ReadonlySet<string> = new Set<CrashTestMarker>([
  "SOA_MARK_PENDING_WRITE_DONE",
  "SOA_MARK_TOOL_INVOKE_START",
  "SOA_MARK_TOOL_INVOKE_DONE",
  "SOA_MARK_COMMITTED_WRITE_DONE",
  "SOA_MARK_DIR_FSYNC_DONE",
  "SOA_MARK_AUDIT_APPEND_DONE",
  "SOA_MARK_AUDIT_BUFFER_WRITE_DONE"
]);

/**
 * §12.5.3 L-51 Finding AE — parse SOA_CRASH_AFTER_MARKER. Returns the
 * CrashTestMarker when the value matches a known §12.5.3 marker,
 * null otherwise. Typos return null so an operator doesn't silently
 * arm a hook they didn't intend.
 */
export function parseCrashAfterMarkerEnv(
  value: string | undefined
): CrashTestMarker | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return CRASH_AFTER_MARKERS.has(trimmed) ? (trimmed as CrashTestMarker) : null;
}

/** Production guard for SOA_CRASH_AFTER_MARKER. Mirrors §12.5.3 markers-env guard. */
export class CrashAfterMarkerOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `CrashAfterMarkerOnPublicListener: SOA_CRASH_AFTER_MARKER is set and ` +
        `the listener binds to non-loopback host "${host}". This env hook ` +
        `SIGKILLs the Runner — MUST NOT be reachable by untrusted principals.`
    );
    this.name = "CrashAfterMarkerOnPublicListener";
  }
}

export function assertCrashAfterMarkerListenerSafe(opts: {
  marker: CrashTestMarker | null;
  host: string;
}): void {
  if (opts.marker === null) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new CrashAfterMarkerOnPublicListener(opts.host);
}
