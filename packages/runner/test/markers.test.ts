import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarkerEmitter,
  parseCrashTestMarkersEnv,
  assertCrashTestMarkersListenerSafe,
  CrashTestMarkersOnPublicListener
} from "../src/markers/index.js";
import {
  SessionPersister,
  type PersistedSession
} from "../src/session/index.js";
import { AuditChain, AuditSink } from "../src/audit/index.js";

// §12.5.3 crash-test markers tests. Validates:
//   1. Emitter primitive (format, on/off, line termination)
//   2. Production guard (loopback-only)
//   3. Env parser
//   4. Cross-platform marker identity (same line format Linux/macOS/Windows)
//   5. Integration: SessionPersister emits DIR_FSYNC_DONE + optional
//      PENDING/COMMITTED_WRITE_DONE per markerPhase hint
//   6. Integration: AuditChain emits AUDIT_APPEND_DONE
//   7. Integration: AuditSink emits AUDIT_BUFFER_WRITE_DONE in buffering states
//   8. Marker ordering across a bracket-persist scenario

const FROZEN_NOW = new Date("2026-04-21T16:00:00.000Z");
const SESSION = "ses_markersfixture0000a1";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-markers-"));
}

function makeCapture(): { lines: string[]; write: (l: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function baseSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    session_id: SESSION,
    format_version: "1.0",
    activeMode: "WorkspaceWrite",
    messages: [],
    workflow: {
      task_id: "task-markers",
      status: "Executing",
      side_effects: [],
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: "sha256:markertoolpool0000000000000000000000000000000000000000000000aa01",
    card_version: "1.0",
    ...overrides
  } as PersistedSession;
}

describe("MarkerEmitter — §12.5.3 primitive", () => {
  it("disabled emitter writes nothing to the sink", () => {
    const cap = makeCapture();
    const emitter = new MarkerEmitter({ enabled: false, write: cap.write });
    emitter.pendingWriteDone(SESSION, 0);
    emitter.toolInvokeStart(SESSION, 0);
    emitter.toolInvokeDone(SESSION, 0, "committed");
    emitter.committedWriteDone(SESSION, 0);
    emitter.dirFsyncDone(SESSION);
    emitter.auditAppendDone("aud_test");
    emitter.auditBufferWriteDone("aud_test");
    expect(cap.lines).toHaveLength(0);
    expect(emitter.isEnabled()).toBe(false);
  });

  it("enabled emitter writes all seven marker types in the documented format", () => {
    const cap = makeCapture();
    const emitter = new MarkerEmitter({ enabled: true, write: cap.write });
    expect(emitter.isEnabled()).toBe(true);
    emitter.pendingWriteDone(SESSION, 0);
    emitter.toolInvokeStart(SESSION, 0);
    emitter.toolInvokeDone(SESSION, 0, "committed");
    emitter.committedWriteDone(SESSION, 0);
    emitter.dirFsyncDone(SESSION);
    emitter.auditAppendDone("aud_recorded000001");
    emitter.auditBufferWriteDone("aud_recorded000001");

    expect(cap.lines).toEqual([
      `SOA_MARK_PENDING_WRITE_DONE session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_TOOL_INVOKE_START session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_TOOL_INVOKE_DONE session_id=${SESSION} side_effect=0 result=committed\n`,
      `SOA_MARK_COMMITTED_WRITE_DONE session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`,
      `SOA_MARK_AUDIT_APPEND_DONE audit_record_id=aud_recorded000001\n`,
      `SOA_MARK_AUDIT_BUFFER_WRITE_DONE audit_record_id=aud_recorded000001\n`
    ]);
  });

  it("TOOL_INVOKE_DONE carries result=committed|compensated per §12.5.3", () => {
    const cap = makeCapture();
    const emitter = new MarkerEmitter({ enabled: true, write: cap.write });
    emitter.toolInvokeDone(SESSION, 2, "committed");
    emitter.toolInvokeDone(SESSION, 3, "compensated");
    expect(cap.lines[0]).toContain("result=committed");
    expect(cap.lines[1]).toContain("result=compensated");
  });

  it("cross-platform identity: every line ends in LF (no CRLF even on Windows)", () => {
    const cap = makeCapture();
    const emitter = new MarkerEmitter({ enabled: true, write: cap.write });
    emitter.dirFsyncDone(SESSION);
    emitter.auditAppendDone("aud_test");
    for (const line of cap.lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.endsWith("\r\n")).toBe(false);
    }
  });
});

describe("parseCrashTestMarkersEnv", () => {
  it("only '1' enables; every other value disables", () => {
    expect(parseCrashTestMarkersEnv(undefined)).toBe(false);
    expect(parseCrashTestMarkersEnv("")).toBe(false);
    expect(parseCrashTestMarkersEnv("0")).toBe(false);
    expect(parseCrashTestMarkersEnv("true")).toBe(false);
    expect(parseCrashTestMarkersEnv("yes")).toBe(false);
    expect(parseCrashTestMarkersEnv("1")).toBe(true);
  });
});

describe("assertCrashTestMarkersListenerSafe — production guard", () => {
  it("disabled env is always safe, regardless of host", () => {
    expect(() =>
      assertCrashTestMarkersListenerSafe({ enabled: false, host: "public.example.com" })
    ).not.toThrow();
  });

  it("enabled + loopback hosts pass", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST", "127.0.0.1"]) {
      expect(() => assertCrashTestMarkersListenerSafe({ enabled: true, host })).not.toThrow();
    }
  });

  it("enabled + non-loopback host throws CrashTestMarkersOnPublicListener", () => {
    for (const host of ["0.0.0.0", "10.0.0.5", "runner.example.com", "[::1234]"]) {
      expect(() =>
        assertCrashTestMarkersListenerSafe({ enabled: true, host })
      ).toThrow(CrashTestMarkersOnPublicListener);
    }
  });
});

describe("SessionPersister integration — DIR_FSYNC_DONE + phase markers", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeSession with enabled markers fires DIR_FSYNC_DONE unconditionally", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const p = new SessionPersister({ sessionDir: dir, markers });
    await p.writeSession(baseSession());
    const dirFsyncLines = cap.lines.filter((l) => l.startsWith("SOA_MARK_DIR_FSYNC_DONE"));
    expect(dirFsyncLines).toHaveLength(1);
    expect(dirFsyncLines[0]).toBe(`SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`);
  });

  it("markerPhase:pending fires PENDING_WRITE_DONE + DIR_FSYNC_DONE in order", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const p = new SessionPersister({ sessionDir: dir, markers });
    await p.writeSession(baseSession(), { markerPhase: { kind: "pending", side_effect: 0 } });
    expect(cap.lines).toEqual([
      `SOA_MARK_PENDING_WRITE_DONE session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`
    ]);
  });

  it("markerPhase:committed fires COMMITTED_WRITE_DONE + DIR_FSYNC_DONE in order", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const p = new SessionPersister({ sessionDir: dir, markers });
    await p.writeSession(baseSession(), { markerPhase: { kind: "committed", side_effect: 2 } });
    expect(cap.lines).toEqual([
      `SOA_MARK_COMMITTED_WRITE_DONE session_id=${SESSION} side_effect=2\n`,
      `SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`
    ]);
  });

  it("disabled markers: writeSession fires nothing (default)", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    // Default construction uses NOOP_EMITTER — no side effects possible to
    // observe here other than no-exception.
    await expect(
      p.writeSession(baseSession(), { markerPhase: { kind: "pending", side_effect: 0 } })
    ).resolves.toBeUndefined();
  });
});

describe("AuditChain integration — AUDIT_APPEND_DONE", () => {
  it("append fires AUDIT_APPEND_DONE keyed to the record's id", () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const chain = new AuditChain(() => FROZEN_NOW, { markers });
    chain.append({ id: "aud_abc0000000000001", kind: "permission-decision", subject_id: "none" });
    expect(cap.lines).toEqual([`SOA_MARK_AUDIT_APPEND_DONE audit_record_id=aud_abc0000000000001\n`]);
  });

  it("multiple appends fire one marker per record in chain order", () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const chain = new AuditChain(() => FROZEN_NOW, { markers });
    chain.append({ id: "aud_00000000000001" });
    chain.append({ id: "aud_00000000000002" });
    chain.append({ id: "aud_00000000000003" });
    expect(cap.lines).toHaveLength(3);
    expect(cap.lines[0]).toContain("aud_00000000000001");
    expect(cap.lines[1]).toContain("aud_00000000000002");
    expect(cap.lines[2]).toContain("aud_00000000000003");
  });

  it("default AuditChain construction (no markers arg) is silent", () => {
    // No crash, no emitter captures to assert against — just verifying
    // backwards-compat construction doesn't throw.
    const chain = new AuditChain(() => FROZEN_NOW);
    const r = chain.append({ id: "aud_silent0000001" });
    expect(r["id"]).toBe("aud_silent0000001");
  });
});

describe("AuditSink integration — AUDIT_BUFFER_WRITE_DONE", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recordAuditRow in degraded-buffering fires AUDIT_BUFFER_WRITE_DONE after fsync", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const sink = new AuditSink({
      sessionDir: dir,
      clock: () => FROZEN_NOW,
      markers,
      initialState: "degraded-buffering"
    });
    const record = {
      id: "aud_buffered000001",
      timestamp: FROZEN_NOW.toISOString(),
      prev_hash: "GENESIS",
      this_hash: "hash0000000000000000000000000000000000000000000000000000000000000001"
    };
    await sink.recordAuditRow(record);
    const bufferLines = cap.lines.filter((l) => l.startsWith("SOA_MARK_AUDIT_BUFFER_WRITE_DONE"));
    expect(bufferLines).toEqual([`SOA_MARK_AUDIT_BUFFER_WRITE_DONE audit_record_id=aud_buffered000001\n`]);
  });

  it("healthy-state recordAuditRow emits NO marker (no-op path)", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const sink = new AuditSink({ sessionDir: dir, clock: () => FROZEN_NOW, markers });
    await sink.recordAuditRow({
      id: "aud_healthy000001",
      timestamp: FROZEN_NOW.toISOString(),
      prev_hash: "GENESIS",
      this_hash: "hashhhhhh"
    });
    const bufferLines = cap.lines.filter((l) => l.startsWith("SOA_MARK_AUDIT_BUFFER_WRITE_DONE"));
    expect(bufferLines).toEqual([]);
  });
});

describe("End-to-end marker ordering — bracket-persist scenario", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("pending → tool-invoke → committed → audit-append fires markers in the documented order", async () => {
    const cap = makeCapture();
    const markers = new MarkerEmitter({ enabled: true, write: cap.write });
    const persister = new SessionPersister({ sessionDir: dir, markers });
    const chain = new AuditChain(() => FROZEN_NOW, { markers });

    // Step 1: persist phase=pending
    await persister.writeSession(baseSession(), {
      markerPhase: { kind: "pending", side_effect: 0 }
    });
    // Step 2: tool invoke start/done (would normally be a real tool call)
    markers.toolInvokeStart(SESSION, 0);
    markers.toolInvokeDone(SESSION, 0, "committed");
    // Step 3: persist phase=committed
    await persister.writeSession(baseSession({ workflow: { task_id: "t", status: "Executing", side_effects: [], checkpoint: {} } }), {
      markerPhase: { kind: "committed", side_effect: 0 }
    });
    // Step 4: append audit row
    chain.append({ id: "aud_bracket000001" });

    // Assert the 6 markers fired in the documented §12.5.3 order
    const expected = [
      `SOA_MARK_PENDING_WRITE_DONE session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`,
      `SOA_MARK_TOOL_INVOKE_START session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_TOOL_INVOKE_DONE session_id=${SESSION} side_effect=0 result=committed\n`,
      `SOA_MARK_COMMITTED_WRITE_DONE session_id=${SESSION} side_effect=0\n`,
      `SOA_MARK_DIR_FSYNC_DONE session_id=${SESSION}\n`,
      `SOA_MARK_AUDIT_APPEND_DONE audit_record_id=aud_bracket000001\n`
    ];
    expect(cap.lines).toEqual(expected);
  });
});
