import { describe, it, expect } from "vitest";
import {
  MarkerEmitter,
  parseCrashAfterMarkerEnv,
  assertCrashAfterMarkerListenerSafe,
  CrashAfterMarkerOnPublicListener,
  type CrashTestMarker
} from "../src/markers/index.js";

// Finding AE / SV-STR-10 — SOA_CRASH_AFTER_MARKER: emitter SIGKILLs the
// process immediately after the named marker writes. Tests use the
// killSelf injection seam so the vitest process itself isn't killed.

describe("AE crash harness — parseCrashAfterMarkerEnv", () => {
  it("undefined / empty → null", () => {
    expect(parseCrashAfterMarkerEnv(undefined)).toBeNull();
    expect(parseCrashAfterMarkerEnv("")).toBeNull();
    expect(parseCrashAfterMarkerEnv("   ")).toBeNull();
  });

  it("known §12.5.3 marker → canonical name", () => {
    const markers: CrashTestMarker[] = [
      "SOA_MARK_PENDING_WRITE_DONE",
      "SOA_MARK_TOOL_INVOKE_START",
      "SOA_MARK_TOOL_INVOKE_DONE",
      "SOA_MARK_COMMITTED_WRITE_DONE",
      "SOA_MARK_DIR_FSYNC_DONE",
      "SOA_MARK_AUDIT_APPEND_DONE",
      "SOA_MARK_AUDIT_BUFFER_WRITE_DONE"
    ];
    for (const m of markers) {
      expect(parseCrashAfterMarkerEnv(m)).toBe(m);
    }
  });

  it("typo → null (safe fallthrough, no surprise arming)", () => {
    expect(parseCrashAfterMarkerEnv("SOA_MARK_PENDING_WRITE_DONEXYZ")).toBeNull();
    expect(parseCrashAfterMarkerEnv("pending_write_done")).toBeNull();
  });

  it("whitespace around known value → trimmed match", () => {
    expect(parseCrashAfterMarkerEnv("  SOA_MARK_PENDING_WRITE_DONE  ")).toBe(
      "SOA_MARK_PENDING_WRITE_DONE"
    );
  });
});

describe("AE crash harness — assertCrashAfterMarkerListenerSafe", () => {
  it("null marker on any host → safe", () => {
    expect(() =>
      assertCrashAfterMarkerListenerSafe({ marker: null, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("marker set on loopback → safe", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LocalHost"]) {
      expect(() =>
        assertCrashAfterMarkerListenerSafe({
          marker: "SOA_MARK_PENDING_WRITE_DONE",
          host
        })
      ).not.toThrow();
    }
  });

  it("marker set on non-loopback → CrashAfterMarkerOnPublicListener", () => {
    expect(() =>
      assertCrashAfterMarkerListenerSafe({
        marker: "SOA_MARK_PENDING_WRITE_DONE",
        host: "0.0.0.0"
      })
    ).toThrow(CrashAfterMarkerOnPublicListener);
  });
});

describe("AE crash harness — MarkerEmitter self-kill", () => {
  it("fires killSelf immediately after the matching marker", () => {
    const lines: string[] = [];
    let killed = 0;
    const em = new MarkerEmitter({
      enabled: true,
      write: (l) => lines.push(l),
      crashAfter: "SOA_MARK_PENDING_WRITE_DONE",
      killSelf: () => {
        killed++;
      }
    });
    em.pendingWriteDone("ses_crashAfterFixture0001", 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("SOA_MARK_PENDING_WRITE_DONE");
    expect(killed).toBe(1);
  });

  it("does NOT fire killSelf on non-matching markers", () => {
    let killed = 0;
    const em = new MarkerEmitter({
      enabled: true,
      write: () => undefined,
      crashAfter: "SOA_MARK_PENDING_WRITE_DONE",
      killSelf: () => {
        killed++;
      }
    });
    em.toolInvokeStart("ses_x", 0);
    em.toolInvokeDone("ses_x", 0, "committed");
    em.committedWriteDone("ses_x", 0);
    em.dirFsyncDone("ses_x");
    em.auditAppendDone("aud_x");
    em.auditBufferWriteDone("aud_x");
    expect(killed).toBe(0);
  });

  it("fires exactly once even if the marker fires twice", () => {
    let killed = 0;
    const em = new MarkerEmitter({
      enabled: true,
      write: () => undefined,
      crashAfter: "SOA_MARK_PENDING_WRITE_DONE",
      killSelf: () => {
        killed++;
      }
    });
    em.pendingWriteDone("ses_x", 0);
    em.pendingWriteDone("ses_x", 1);
    expect(killed).toBe(1);
  });

  it("disabled emitter → no kill even when crashAfter set", () => {
    let killed = 0;
    const em = new MarkerEmitter({
      enabled: false,
      crashAfter: "SOA_MARK_PENDING_WRITE_DONE",
      killSelf: () => {
        killed++;
      }
    });
    em.pendingWriteDone("ses_x", 0);
    expect(killed).toBe(0);
  });

  it("each marker method wires the crash hook", () => {
    const cases: Array<[CrashTestMarker, (e: MarkerEmitter) => void]> = [
      ["SOA_MARK_PENDING_WRITE_DONE", (e) => e.pendingWriteDone("s", 0)],
      ["SOA_MARK_TOOL_INVOKE_START", (e) => e.toolInvokeStart("s", 0)],
      ["SOA_MARK_TOOL_INVOKE_DONE", (e) => e.toolInvokeDone("s", 0, "committed")],
      ["SOA_MARK_COMMITTED_WRITE_DONE", (e) => e.committedWriteDone("s", 0)],
      ["SOA_MARK_DIR_FSYNC_DONE", (e) => e.dirFsyncDone("s")],
      ["SOA_MARK_AUDIT_APPEND_DONE", (e) => e.auditAppendDone("a")],
      ["SOA_MARK_AUDIT_BUFFER_WRITE_DONE", (e) => e.auditBufferWriteDone("a")]
    ];
    for (const [marker, fire] of cases) {
      let killed = 0;
      const em = new MarkerEmitter({
        enabled: true,
        write: () => undefined,
        crashAfter: marker,
        killSelf: () => {
          killed++;
        }
      });
      fire(em);
      expect(killed).toBe(1);
    }
  });
});
