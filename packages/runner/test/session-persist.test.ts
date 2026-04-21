import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionPersister,
  SessionFormatIncompatible,
  type PersistedSession
} from "../src/session/index.js";

// §12.3 crash-safe persistence tests. Covers SV-SESS-01, -02, -06 (POSIX),
// -07 (Windows) — the actual crash simulations live in M2-T7; this file
// exercises the write/read primitives + partial-write detection.

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-session-"));
}

function baseSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    session_id: "ses_persistfixture00a1",
    format_version: "1.0",
    activeMode: "ReadOnly",
    messages: [],
    workflow: {
      task_id: "task-abc",
      status: "Planning",
      side_effects: [],
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    card_version: "1.0",
    ...overrides
  } as PersistedSession;
}

describe("SessionPersister §12.3 atomic writes", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpSessionDir();
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows, read-only probe dir chmod leftovers can linger; best-effort.
    }
  });

  it("SV-SESS-01/-02: writeSession produces a valid readable final file with no tmp remnants", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    const session = baseSession();
    await p.writeSession(session);
    const final = p.pathFor(session.session_id);
    expect(existsSync(final)).toBe(true);
    // No .tmp files left behind.
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftover).toEqual([]);
    // Round-trip.
    const loaded = await p.readSession(session.session_id);
    expect(loaded.session_id).toBe(session.session_id);
    expect(loaded.activeMode).toBe("ReadOnly");
    expect(loaded.format_version).toBe("1.0");
  });

  it("POSIX write→fsync→rename→dir-fsync sequence: afterFsyncBeforeRename hook observes final-absent state", async () => {
    const p = new SessionPersister({ sessionDir: dir, forceWindowsSequence: false });
    const session = baseSession();
    const final = p.pathFor(session.session_id);
    let midWindowHit = false;
    let midFinalExists: boolean | null = null;
    let midTmpCount = -1;
    await p.writeSession(session, {
      afterFsyncBeforeRename: () => {
        midWindowHit = true;
        midFinalExists = existsSync(final);
        midTmpCount = readdirSync(dir).filter((f) => f.includes(".tmp.")).length;
      }
    });
    expect(midWindowHit).toBe(true);
    // Critical crash-safety property: between fsync(tmp) and rename, the final
    // file does NOT exist yet. A crash here leaves no damage.
    expect(midFinalExists).toBe(false);
    // The tmp file DOES exist at the boundary (the fsynced bytes are durable).
    expect(midTmpCount).toBe(1);
    // After the call returns, the final file is present and the tmp is gone.
    expect(existsSync(final)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("Windows flush/move sequence: forceWindowsSequence=true still leaves a valid final file", async () => {
    const p = new SessionPersister({ sessionDir: dir, forceWindowsSequence: true });
    const session = baseSession({ session_id: "ses_winseqfixture0000" });
    await p.writeSession(session);
    const final = p.pathFor(session.session_id);
    expect(existsSync(final)).toBe(true);
    const loaded = await p.readSession(session.session_id);
    expect(loaded.session_id).toBe(session.session_id);
    // No tmp left over.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("stageActivate: multi-file commit writes all tmps, then renames all; all final files readable", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    const sessions = [
      baseSession({ session_id: "ses_stage0000000001aa" }),
      baseSession({ session_id: "ses_stage0000000002bb", activeMode: "WorkspaceWrite" }),
      baseSession({ session_id: "ses_stage0000000003cc", activeMode: "DangerFullAccess" })
    ];
    await p.stageActivate(sessions);
    for (const s of sessions) {
      const loaded = await p.readSession(s.session_id);
      expect(loaded.session_id).toBe(s.session_id);
      expect(loaded.activeMode).toBe(s.activeMode);
    }
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("concurrent-serialize: two parallel writes to the same session both complete; neither corrupts the final file", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    const session_id = "ses_concurrentfixture0a";
    const a = baseSession({ session_id, activeMode: "ReadOnly" });
    const b = baseSession({ session_id, activeMode: "WorkspaceWrite" });
    // Explicit distinct tmp suffixes so the two tmps don't collide at creation.
    await Promise.all([
      p.writeSession(a, { tmpSuffix: "aaa1" }),
      p.writeSession(b, { tmpSuffix: "bbb2" })
    ]);
    const loaded = await p.readSession(session_id);
    // Either write wins; the file is always a valid PersistedSession.
    expect(["ReadOnly", "WorkspaceWrite"]).toContain(loaded.activeMode);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("SV-SESS-06: partial-write detection → SessionFormatIncompatible reason=partial-write-detected", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    const session = baseSession({ session_id: "ses_partialfixture000a" });
    // Simulate a partial write: JSON missing the closing brace (classic tear).
    const truncated = JSON.stringify(session).slice(0, -5);
    writeFileSync(p.pathFor(session.session_id), truncated);
    let caught: unknown;
    try {
      await p.readSession(session.session_id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFormatIncompatible);
    expect((caught as SessionFormatIncompatible).reason).toBe("partial-write-detected");
  });

  it("SV-SESS-07: corrupted-file detection → SessionFormatIncompatible reason=corrupted-json", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    // Payload ends with "}" but the JSON itself is syntactically invalid
    // (duplicate keys are fine for JSON.parse; use an unquoted identifier).
    writeFileSync(p.pathFor("ses_corruptedfixture0a"), "{ session_id: ses_corrupted }");
    let caught: unknown;
    try {
      await p.readSession("ses_corruptedfixture0a");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFormatIncompatible);
    expect((caught as SessionFormatIncompatible).reason).toBe("corrupted-json");
  });

  it("writable-probe: succeeds on a writable dir, regressing past M1 no-persistence state", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    await expect(p.writableProbe()).resolves.toBeUndefined();
    // No probe file lingers after the call.
    const leftover = readdirSync(dir).filter((f) => f.startsWith(".probe."));
    expect(leftover).toEqual([]);
  });

  it("read of an unknown session_id throws SessionFormatIncompatible reason=file-missing", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    let caught: unknown;
    try {
      await p.readSession("ses_unknownfixture0001");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFormatIncompatible);
    expect((caught as SessionFormatIncompatible).reason).toBe("file-missing");
  });

  it("read of a valid file with bad format_version throws SessionFormatIncompatible reason=bad-format-version", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    const session = baseSession({ session_id: "ses_badformatfixture0a" });
    const mutated = { ...session, format_version: "0.9" };
    writeFileSync(p.pathFor(session.session_id), JSON.stringify(mutated));
    let caught: unknown;
    try {
      await p.readSession(session.session_id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFormatIncompatible);
    expect((caught as SessionFormatIncompatible).reason).toBe("bad-format-version");
  });

  it("schema-violation: empty JSON object fails session.schema validation", async () => {
    const p = new SessionPersister({ sessionDir: dir });
    writeFileSync(p.pathFor("ses_schemavfixture0001"), "{}");
    let caught: unknown;
    try {
      await p.readSession("ses_schemavfixture0001");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionFormatIncompatible);
    expect((caught as SessionFormatIncompatible).reason).toBe("schema-violation");
  });
});
