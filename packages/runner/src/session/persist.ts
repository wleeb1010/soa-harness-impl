/**
 * §12.3 Crash-safe session-file persistence.
 *
 * Write protocol (SV-SESS-01, SV-SESS-02, SV-SESS-06, SV-SESS-07):
 *
 *   POSIX:    open(tmp,"w") → writeFile → fh.sync() (fsync tmp) → close →
 *             rename(tmp, final) → open(dir,"r") → fh.sync() (fsync dir) → close
 *
 *   Windows:  open(tmp,"w") → writeFile → fh.sync() (FlushFileBuffers) → close →
 *             rename(tmp, final) [libuv → MoveFileExW(MOVEFILE_REPLACE_EXISTING)] →
 *             open(final,"r+") → fh.sync() (FlushFileBuffers on final, belt-and-
 *             suspenders approximation of WRITE_THROUGH; Win32 does not expose
 *             directory fsync, so the final-file flush is the durability boundary)
 *
 * Atomicity guarantee: the rename step is atomic per-file on both platforms
 * when tmp and final are on the same volume. Concurrent readers see either the
 * pre-commit or post-commit state — never a half-written file. A crash during
 * write leaves the previous final intact (the new state lives only in tmp).
 *
 * Read side (SV-SESS-06 partial-write detection, SV-SESS-07 corruption):
 *   invalid JSON, schema violation, wrong format_version → SessionFormatIncompatible
 *
 * Writable-probe (§5.4 persistence-unwritable readiness reason):
 *   round-trips a tiny probe file; failure surfaces to /ready.
 *
 * M2-T1a scope: single-session and stage-activated multi-session writes. Resume
 * algorithm, side-effect phase transitions, and bracket-persist timing live in
 * M2-T2 and M2-T7.
 */

import { promises as fsp } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { PersistedSession } from "./migrate.js";

const IS_WIN32 = platform() === "win32";

export type SessionFormatIncompatibleReason =
  | "corrupted-json"
  | "partial-write-detected"
  | "schema-violation"
  | "bad-format-version"
  | "file-missing";

export class SessionFormatIncompatible extends Error {
  readonly reason: SessionFormatIncompatibleReason;
  readonly path: string;
  readonly detail?: string;
  constructor(path: string, reason: SessionFormatIncompatibleReason, detail?: string) {
    super(
      `SessionFormatIncompatible reason=${reason} path="${path}"` + (detail ? ` detail=${detail}` : "")
    );
    this.name = "SessionFormatIncompatible";
    this.path = path;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface SessionPersisterOptions {
  /** Directory where session files live. Created on first write. */
  sessionDir: string;
  /**
   * Override the platform detection. Defaults to `os.platform() === "win32"`.
   * Tests force the other branch to exercise both write protocols on a single CI leg.
   */
  forceWindowsSequence?: boolean;
}

export interface WriteSessionOptions {
  /**
   * Override the random tmp suffix — used by tests to assert the exact tmp
   * filename shape or to deliberately collide with a concurrent write.
   */
  tmpSuffix?: string;
  /**
   * Inject a hook fired immediately after the tmp file is written + fsynced but
   * BEFORE rename. Tests use it to simulate a crash boundary between fsync(tmp)
   * and rename — the final file MUST be absent in that window.
   */
  afterFsyncBeforeRename?: () => Promise<void> | void;
}

export class SessionPersister {
  private readonly sessionDir: string;
  private readonly windowsSequence: boolean;
  /** Per-session_id in-process serialization. Two concurrent writeSession
   *  calls for the same session_id chain rather than race — the second waits
   *  for the first. On Win32 this also avoids EPERM from MoveFileExW racing
   *  with the prior writer's final-file fsync handle. */
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(opts: SessionPersisterOptions) {
    this.sessionDir = opts.sessionDir;
    this.windowsSequence = opts.forceWindowsSequence ?? IS_WIN32;
  }

  /** Absolute path for a given session id. The id pattern is already filename-safe. */
  pathFor(session_id: string): string {
    return join(this.sessionDir, `${session_id}.json`);
  }

  /**
   * Atomically write a session file. Guarantees:
   *   - final file contains the complete, fsync'd payload after the call returns
   *   - on crash mid-write, the previous final file is untouched
   *   - concurrent writers leave ≥ 1 final file intact (last rename wins;
   *     neither leaves a corrupt file)
   */
  async writeSession(file: PersistedSession, opts: WriteSessionOptions = {}): Promise<void> {
    const prior = this.writeLocks.get(file.session_id) ?? Promise.resolve();
    const mine = prior.catch(() => undefined).then(() => this.doWriteSession(file, opts));
    this.writeLocks.set(file.session_id, mine);
    try {
      await mine;
    } finally {
      if (this.writeLocks.get(file.session_id) === mine) {
        this.writeLocks.delete(file.session_id);
      }
    }
  }

  private async doWriteSession(file: PersistedSession, opts: WriteSessionOptions): Promise<void> {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    const final = this.pathFor(file.session_id);
    const tmp = this.tmpPathFor(final, opts.tmpSuffix);
    const bytes = Buffer.from(JSON.stringify(file));

    await this.writeAndFsyncTmp(tmp, bytes);
    if (opts.afterFsyncBeforeRename) await opts.afterFsyncBeforeRename();
    await fsp.rename(tmp, final);
    await this.finalizeAfterRename(final);
  }

  /**
   * Stage-activate multi-file commit (§12.3): write all tmps + fsync, then
   * rename all. Per-file atomicity holds; a crash mid-activation leaves some
   * files in the new state and some in the old state, but no file is torn.
   */
  async stageActivate(files: PersistedSession[]): Promise<void> {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    const pairs: { tmp: string; final: string }[] = [];
    for (const file of files) {
      const final = this.pathFor(file.session_id);
      const tmp = this.tmpPathFor(final);
      const bytes = Buffer.from(JSON.stringify(file));
      await this.writeAndFsyncTmp(tmp, bytes);
      pairs.push({ tmp, final });
    }
    for (const { tmp, final } of pairs) {
      await fsp.rename(tmp, final);
    }
    // Final durability pass — one fsync on the directory (POSIX) or on each
    // file (Win32) covers the batched rename.
    if (!this.windowsSequence) {
      await this.fsyncDir(dirname(pairs[0]!.final));
    } else {
      for (const { final } of pairs) {
        await this.fsyncFinalForWindows(final);
      }
    }
  }

  /** Read + validate a persisted session. Partial writes + corruption are caught. */
  async readSession(session_id: string): Promise<PersistedSession> {
    const path = this.pathFor(session_id);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionFormatIncompatible(path, "file-missing");
      }
      throw err;
    }
    return this.parseAndValidate(path, bytes);
  }

  /**
   * Lenient read path for §12.5 resume. Enforces only the format_version
   * and partial-write / corruption checks — does NOT run the full
   * session.schema.json validation. The resume algorithm accepts pre-1.0
   * session files (missing `activeMode` per L-20) and migrates them before
   * re-validating; strict validation at read time would reject those files
   * before migration can run.
   */
  async readSessionForResume(session_id: string): Promise<PersistedSession> {
    const path = this.pathFor(session_id);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionFormatIncompatible(path, "file-missing");
      }
      throw err;
    }
    return this.parseLenient(path, bytes);
  }

  /** Shared lenient parse — shape + format_version only, no session.schema run. */
  parseLenient(path: string, bytes: Buffer): PersistedSession {
    if (bytes.length === 0) {
      throw new SessionFormatIncompatible(path, "partial-write-detected", "empty-file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      const trimmed = bytes.toString("utf8").trimEnd();
      const looksTruncated = !trimmed.endsWith("}") && !trimmed.endsWith("]");
      throw new SessionFormatIncompatible(
        path,
        looksTruncated ? "partial-write-detected" : "corrupted-json",
        (err as Error).message
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SessionFormatIncompatible(path, "schema-violation", "top-level not an object");
    }
    const maybe = parsed as { format_version?: unknown };
    if (maybe.format_version !== "1.0") {
      // §12.5 step 1 — strict format_version match. Missing or drifted
      // values trip SessionFormatIncompatible (NOT bad-format-version —
      // resume treats any departure from "1.0" as incompatibility).
      throw new SessionFormatIncompatible(
        path,
        "bad-format-version",
        `got=${JSON.stringify(maybe.format_version)}`
      );
    }
    return parsed as PersistedSession;
  }

  /** Parse + validate bytes without touching the filesystem. Shared by read + tests. */
  parseAndValidate(path: string, bytes: Buffer): PersistedSession {
    if (bytes.length === 0) {
      throw new SessionFormatIncompatible(path, "partial-write-detected", "empty-file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      // A truncated write surfaces as invalid JSON. Distinguish truncation
      // (common) from outright corruption (rare) by a cheap heuristic: the
      // closing brace is the last non-whitespace byte of a valid JSON object.
      const trimmed = bytes.toString("utf8").trimEnd();
      const looksTruncated = !trimmed.endsWith("}") && !trimmed.endsWith("]");
      throw new SessionFormatIncompatible(
        path,
        looksTruncated ? "partial-write-detected" : "corrupted-json",
        (err as Error).message
      );
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SessionFormatIncompatible(path, "schema-violation", "top-level not an object");
    }

    const maybe = parsed as { format_version?: unknown };
    if (maybe.format_version !== undefined && maybe.format_version !== "1.0") {
      // Format-version mismatch is a structured signal distinct from a general
      // schema violation — resume algorithms flip it into a v1.1 escape hatch.
      throw new SessionFormatIncompatible(
        path,
        "bad-format-version",
        `got=${JSON.stringify(maybe.format_version)}`
      );
    }

    const validator = schemaRegistry["session"];
    if (!validator(parsed)) {
      throw new SessionFormatIncompatible(
        path,
        "schema-violation",
        JSON.stringify(validator.errors ?? [])
      );
    }

    return parsed as PersistedSession;
  }

  /**
   * §5.4 persistence-unwritable readiness hook. Writes a tiny probe file,
   * fsyncs it, unlinks it. Propagates any filesystem error to the caller
   * (readiness probe turns that into a 503 + closed-enum reason).
   */
  async writableProbe(): Promise<void> {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    const probe = join(this.sessionDir, `.probe.${randomBytes(4).toString("hex")}`);
    let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      fh = await fsp.open(probe, "w", 0o600);
      await fh.writeFile("probe");
      await fh.sync();
    } finally {
      if (fh) await fh.close();
      await fsp.unlink(probe).catch(() => undefined);
    }
  }

  // ---- internals ---------------------------------------------------------

  private tmpPathFor(final: string, explicitSuffix?: string): string {
    const suffix = explicitSuffix ?? randomBytes(4).toString("hex");
    return `${final}.tmp.${suffix}`;
  }

  private async writeAndFsyncTmp(tmp: string, bytes: Buffer): Promise<void> {
    const fh = await fsp.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(bytes);
      // fsync: POSIX → fsync(2); Win32 → FlushFileBuffers. Same durability
      // guarantee for the tmp file bytes.
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async finalizeAfterRename(final: string): Promise<void> {
    if (!this.windowsSequence) {
      await this.fsyncDir(dirname(final));
    } else {
      await this.fsyncFinalForWindows(final);
    }
  }

  private async fsyncDir(dir: string): Promise<void> {
    // POSIX: open the directory read-only and fsync it so the rename is durable.
    // Win32 does not allow fsync on a directory handle; when the POSIX branch
    // runs on a Win32 host (test simulation via forceWindowsSequence=false)
    // the syscall throws EPERM — treat as a no-op so the control-flow test
    // still exercises the crash-safety window assertion.
    const fh = await fsp.open(dir, "r");
    try {
      try {
        await fh.sync();
      } catch (err) {
        if (IS_WIN32 && (err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }
    } finally {
      await fh.close();
    }
  }

  private async fsyncFinalForWindows(final: string): Promise<void> {
    // Win32 does not let us fsync a directory handle. The rename already went
    // through MoveFileExW(MOVEFILE_REPLACE_EXISTING). As a belt-and-suspenders
    // approximation of MOVEFILE_WRITE_THROUGH, open the final file and fsync
    // (FlushFileBuffers) it. The final-file flush is the durability boundary.
    const fh = await fsp.open(final, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}
