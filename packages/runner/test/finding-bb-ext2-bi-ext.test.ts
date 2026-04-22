import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandlerKeyRegistry,
  buildPublicKeyFromSpki,
  appendSuspectDecisionsForKid
} from "../src/attestation/index.js";
import { AuditChain } from "../src/audit/index.js";
import {
  SessionPersister,
  scanAndResumeInProgressSessions,
  type PersistedSession,
  type ResumeContext
} from "../src/session/index.js";

// ---------------------------------------------------------------------------
// BB-ext-2: dynamic PDA verifier lookup — buildPublicKeyFromSpki accepts
// both hex and base64url DER and returns a KeyObject that jose can verify.

describe("BB-ext-2 — buildPublicKeyFromSpki", () => {
  it("constructs a verify KeyObject from base64url DER SPKI (Ed25519)", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const b64url = spkiDer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const reconstructed = buildPublicKeyFromSpki(b64url);
    // Re-export + compare DER bytes.
    const roundtrip = reconstructed.export({ format: "der", type: "spki" }) as Buffer;
    expect(roundtrip.equals(spkiDer)).toBe(true);
  });

  it("constructs a verify KeyObject from hex SPKI", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const hex = spkiDer.toString("hex");
    const reconstructed = buildPublicKeyFromSpki(hex);
    const roundtrip = reconstructed.export({ format: "der", type: "spki" }) as Buffer;
    expect(roundtrip.equals(spkiDer)).toBe(true);
  });

  it("empty SPKI → throws", () => {
    expect(() => buildPublicKeyFromSpki("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BI-impl-ext: RUNNER_RESUME admin rows now carry retention_class derived
// from PersistedSession.activeMode.

const T_REF = new Date("2026-04-22T20:00:00Z");
const CARD_VERSION = "1.0";
const TOOL_POOL_HASH = "sha256:bi-ext-pool-00000000000000000000000000000000000000000000000000000000";

describe("BI-impl-ext — RUNNER_RESUME retention_class inheritance", () => {
  let dir: string;
  let persister: SessionPersister;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bi-ext-"));
    persister = new SessionPersister({ sessionDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeCtx(): ResumeContext {
    return {
      currentCardVersion: CARD_VERSION,
      currentToolPoolHash: TOOL_POOL_HASH,
      toolCompensation: () => ({ canCompensate: false }),
      replayPending: async () => null,
      compensate: async () => undefined,
      cardActiveMode: "WorkspaceWrite",
      clock: () => T_REF
    };
  }

  function makeSession(id: string, activeMode: string): PersistedSession {
    return {
      session_id: id,
      format_version: "1.0",
      activeMode,
      messages: [],
      workflow: {
        task_id: `task-${id}`,
        status: "Executing",
        side_effects: [],
        checkpoint: {}
      },
      counters: {},
      tool_pool_hash: TOOL_POOL_HASH,
      card_version: CARD_VERSION
    } as PersistedSession;
  }

  it("DangerFullAccess session → RUNNER_RESUME row carries retention_class=dfa-365d", async () => {
    const s = makeSession("ses_biExtDfa000000000001", "DangerFullAccess");
    await persister.writeSession(s);
    const chain = new AuditChain(() => T_REF);
    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      chain,
      log: () => undefined,
      clock: () => T_REF
    });
    const snap = chain.snapshot();
    const resumeRow = snap.find((r) => r["tool"] === "RUNNER_RESUME");
    expect(resumeRow).toBeDefined();
    expect(resumeRow!["retention_class"]).toBe("dfa-365d");
  });

  it("WorkspaceWrite session → RUNNER_RESUME row carries retention_class=standard-90d", async () => {
    const s = makeSession("ses_biExtWsw000000000001", "WorkspaceWrite");
    await persister.writeSession(s);
    const chain = new AuditChain(() => T_REF);
    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      chain,
      log: () => undefined,
      clock: () => T_REF
    });
    const snap = chain.snapshot();
    const resumeRow = snap.find((r) => r["tool"] === "RUNNER_RESUME");
    expect(resumeRow).toBeDefined();
    expect(resumeRow!["retention_class"]).toBe("standard-90d");
  });

  it("ReadOnly session → retention_class=standard-90d (non-DFA fallback)", async () => {
    const s = makeSession("ses_biExtRdo000000000001", "ReadOnly");
    await persister.writeSession(s);
    const chain = new AuditChain(() => T_REF);
    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      chain,
      log: () => undefined,
      clock: () => T_REF
    });
    const snap = chain.snapshot();
    const resumeRow = snap.find((r) => r["tool"] === "RUNNER_RESUME");
    expect(resumeRow!["retention_class"]).toBe("standard-90d");
  });
});

// ---------------------------------------------------------------------------
// BI-impl-ext: SuspectDecision rows inherit retention_class from referenced row.

describe("BI-impl-ext — SuspectDecision retention_class inheritance", () => {
  it("inherits retention_class from the referenced decision row", () => {
    const chain = new AuditChain(() => T_REF);
    // Append a DFA decision row with retention_class=dfa-365d
    chain.append({
      id: "aud_victim",
      session_id: "ses_biExtSuspect00000001",
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "a".repeat(64),
      capability: "DangerFullAccess",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "t",
      signer_key_id: "suspect-kid",
      retention_class: "dfa-365d"
    });
    appendSuspectDecisionsForKid({
      chain,
      kid: "suspect-kid",
      clock: () => T_REF,
      revokedAtIso: T_REF.toISOString()
    });
    const snap = chain.snapshot();
    const suspect = snap.find((r) => r["decision"] === "SuspectDecision");
    expect(suspect).toBeDefined();
    expect(suspect!["retention_class"]).toBe("dfa-365d");
  });

  it("defaults to standard-90d when referenced row lacks retention_class (legacy row)", () => {
    const chain = new AuditChain(() => T_REF);
    chain.append({
      id: "aud_legacy",
      session_id: "ses_biExtSuspect00000002",
      subject_id: "u",
      tool: "fs_write",
      args_digest: "sha256:" + "b".repeat(64),
      capability: "ReadOnly",
      control: "AutoAllow",
      handler: "Interactive",
      decision: "AutoAllow",
      reason: "t",
      signer_key_id: "suspect-kid-2"
      // note: no retention_class
    });
    appendSuspectDecisionsForKid({
      chain,
      kid: "suspect-kid-2",
      clock: () => T_REF,
      revokedAtIso: T_REF.toISOString()
    });
    const snap = chain.snapshot();
    const suspect = snap.find((r) => r["decision"] === "SuspectDecision");
    expect(suspect!["retention_class"]).toBe("standard-90d");
  });
});
