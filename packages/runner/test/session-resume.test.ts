import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionPersister,
  resumeSession,
  CardVersionDrift,
  type PersistedSession,
  type PersistedSideEffect,
  type ResumeContext
} from "../src/session/index.js";
import { ToolPoolStale } from "../src/registry/index.js";

// §12.5 resume algorithm tests. Covers HR-04 (pending replays),
// HR-05 (committed does NOT replay), SV-SESS-08 (CardVersionDrift),
// SV-SESS-09 (tool-pool-hash mismatch), SV-SESS-10 (inflight →
// ResumeCompensationGap when tool can't compensate).

const FROZEN_NOW = new Date("2026-04-21T13:00:00.000Z");
const SESSION = "ses_resumefixture000001x";
const CARD_VERSION = "1.0";
const TOOL_POOL_HASH = "sha256:toolpool0000000000000000000000000000000000000000000000000000aa01";

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-resume-"));
}

function baseSession(overrides: {
  side_effects?: PersistedSideEffect[];
  card_version?: string;
  tool_pool_hash?: string;
  activeMode?: PersistedSession["activeMode"];
} = {}): PersistedSession {
  return {
    session_id: SESSION,
    format_version: "1.0",
    activeMode: overrides.activeMode ?? "WorkspaceWrite",
    created_at: "2026-04-21T12:00:00.000Z",
    messages: [],
    workflow: {
      task_id: "task-resume",
      status: "Executing",
      side_effects: overrides.side_effects ?? [],
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: overrides.tool_pool_hash ?? TOOL_POOL_HASH,
    card_version: overrides.card_version ?? CARD_VERSION
  } as PersistedSession;
}

function makeCtx(overrides: Partial<ResumeContext> & {
  replayCalls?: PersistedSideEffect[];
  compensateCalls?: PersistedSideEffect[];
  toolCompensateMap?: Record<string, boolean>;
} = {}): ResumeContext {
  const replayCalls = overrides.replayCalls ?? [];
  const compensateCalls = overrides.compensateCalls ?? [];
  const toolCompensateMap = overrides.toolCompensateMap ?? {};
  return {
    currentCardVersion: overrides.currentCardVersion ?? CARD_VERSION,
    currentToolPoolHash: overrides.currentToolPoolHash ?? TOOL_POOL_HASH,
    toolCompensation: overrides.toolCompensation
      ?? ((toolName) => ({ canCompensate: toolCompensateMap[toolName] ?? false })),
    replayPending:
      overrides.replayPending
      ?? (async (se) => {
        replayCalls.push(se);
        return "sha256:replayedresult00000000000000000000000000000000000000000000000000";
      }),
    compensate:
      overrides.compensate
      ?? (async (se) => {
        compensateCalls.push(se);
      }),
    cardActiveMode: overrides.cardActiveMode ?? "WorkspaceWrite",
    clock: overrides.clock ?? (() => FROZEN_NOW)
  };
}

describe("resumeSession §12.5 steps 1-4", () => {
  let dir: string;
  let persister: SessionPersister;

  beforeEach(() => {
    dir = tmpSessionDir();
    persister = new SessionPersister({ sessionDir: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("HR-04 — pending replays: replayPending is invoked and phase → committed", async () => {
    const pending: PersistedSideEffect = {
      tool: "fs__write_file",
      idempotency_key: "idk-pending-01",
      phase: "pending",
      args_digest: "sha256:aaaa000000000000000000000000000000000000000000000000000000000001",
      first_attempted_at: "2026-04-21T12:30:00.000Z",
      last_phase_transition_at: "2026-04-21T12:30:00.000Z"
    };
    await persister.writeSession(baseSession({ side_effects: [pending] }));
    const replayCalls: PersistedSideEffect[] = [];
    const ctx = makeCtx({ replayCalls });

    const outcome = await resumeSession(persister, SESSION, ctx);

    expect(outcome.kind).toBe("resumed");
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]?.idempotency_key).toBe("idk-pending-01");
    expect(outcome.sideEffects[0]?.action).toBe("replayed");

    // Persisted state reflects the phase transition — HR-05 follow-on
    // invariant: a subsequent resume MUST see phase=committed.
    const reread = await persister.readSession(SESSION);
    const postSe = (reread.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0];
    expect(postSe?.phase).toBe("committed");
    expect(postSe?.result_digest).toMatch(/^sha256:/);
    expect(postSe?.last_phase_transition_at).toBe(FROZEN_NOW.toISOString());
  });

  it("HR-05 — committed skips: replayPending is NOT invoked; phase stays committed", async () => {
    const committed: PersistedSideEffect = {
      tool: "fs__write_file",
      idempotency_key: "idk-committed-01",
      phase: "committed",
      args_digest: "sha256:bbbb000000000000000000000000000000000000000000000000000000000002",
      result_digest: "sha256:bbbb000000000000000000000000000000000000000000000000000000000022",
      first_attempted_at: "2026-04-21T12:30:00.000Z",
      last_phase_transition_at: "2026-04-21T12:31:00.000Z"
    };
    await persister.writeSession(baseSession({ side_effects: [committed] }));
    const replayCalls: PersistedSideEffect[] = [];
    const ctx = makeCtx({ replayCalls });

    const outcome = await resumeSession(persister, SESSION, ctx);

    expect(replayCalls).toHaveLength(0);
    expect(outcome.sideEffects[0]?.action).toBe("skipped");

    // Idempotency key MUST be preserved across resume (SV-SESS-04).
    const reread = await persister.readSession(SESSION);
    const postSe = (reread.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0];
    expect(postSe?.phase).toBe("committed");
    expect(postSe?.idempotency_key).toBe("idk-committed-01");
    expect(postSe?.last_phase_transition_at).toBe("2026-04-21T12:31:00.000Z"); // unchanged
  });

  it("SV-SESS-08 — card_version mismatch throws CardVersionDrift", async () => {
    await persister.writeSession(baseSession({ card_version: "0.9-legacy" }));
    const ctx = makeCtx();
    let caught: unknown;
    try {
      await resumeSession(persister, SESSION, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CardVersionDrift);
    const drift = caught as CardVersionDrift;
    expect(drift.stopReason).toBe("CardVersionDrift");
    expect(drift.expected).toBe("1.0");
    expect(drift.actual).toBe("0.9-legacy");
    expect(drift.sessionId).toBe(SESSION);
  });

  it("SV-SESS-09 — tool_pool_hash mismatch throws ToolPoolStale reason=tool-pool-hash-mismatch", async () => {
    await persister.writeSession(
      baseSession({ tool_pool_hash: "sha256:stale00000000000000000000000000000000000000000000000000000000aa01" })
    );
    const ctx = makeCtx();
    let caught: unknown;
    try {
      await resumeSession(persister, SESSION, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolPoolStale);
    const stale = caught as ToolPoolStale;
    expect(stale.reason).toBe("tool-pool-hash-mismatch");
    expect(stale.offendingTool).toBe(SESSION);
  });

  it("SV-SESS-10 — inflight without compensate → mark compensated with ResumeCompensationGap note", async () => {
    const inflight: PersistedSideEffect = {
      tool: "fs__write_file",
      idempotency_key: "idk-inflight-01",
      phase: "inflight",
      args_digest: "sha256:cccc000000000000000000000000000000000000000000000000000000000003",
      first_attempted_at: "2026-04-21T12:30:00.000Z",
      last_phase_transition_at: "2026-04-21T12:30:00.000Z"
    };
    await persister.writeSession(baseSession({ side_effects: [inflight] }));

    const compensateCalls: PersistedSideEffect[] = [];
    // toolCompensation returns canCompensate=false — the write tool in this
    // fixture doesn't advertise undo support.
    const ctx = makeCtx({ compensateCalls, toolCompensateMap: { fs__write_file: false } });

    const outcome = await resumeSession(persister, SESSION, ctx);

    expect(compensateCalls).toHaveLength(0); // compensate NOT invoked
    expect(outcome.sideEffects[0]?.action).toBe("compensation-gap");

    const reread = await persister.readSession(SESSION);
    const postSe = (reread.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0];
    expect(postSe?.phase).toBe("compensated");
    expect((postSe as PersistedSideEffect)._resume_note).toBe("ResumeCompensationGap");
    expect(postSe?.last_phase_transition_at).toBe(FROZEN_NOW.toISOString());
  });

  it("inflight WITH compensate support → compensate invoked; phase → compensated", async () => {
    const inflight: PersistedSideEffect = {
      tool: "fs__delete_file",
      idempotency_key: "idk-inflight-02",
      phase: "inflight",
      args_digest: "sha256:dddd000000000000000000000000000000000000000000000000000000000004",
      first_attempted_at: "2026-04-21T12:30:00.000Z",
      last_phase_transition_at: "2026-04-21T12:30:00.000Z"
    };
    await persister.writeSession(baseSession({ side_effects: [inflight] }));

    const compensateCalls: PersistedSideEffect[] = [];
    const ctx = makeCtx({ compensateCalls, toolCompensateMap: { fs__delete_file: true } });

    const outcome = await resumeSession(persister, SESSION, ctx);

    expect(compensateCalls).toHaveLength(1);
    expect(compensateCalls[0]?.idempotency_key).toBe("idk-inflight-02");
    expect(outcome.sideEffects[0]?.action).toBe("compensated");

    const reread = await persister.readSession(SESSION);
    const postSe = (reread.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0];
    expect(postSe?.phase).toBe("compensated");
    // No gap note when compensation actually ran.
    expect((postSe as PersistedSideEffect)._resume_note).toBeUndefined();
  });

  it("pre-1.0 migration — session file missing activeMode picks it up from the Agent Card", async () => {
    // Write a raw pre-1.0 file that predates the L-20 activeMode-required
    // refresh. Bypass SessionPersister.writeSession (which would reject on
    // post-write read-validation); write the bytes directly.
    const preV1: Omit<PersistedSession, "activeMode"> & { activeMode?: never } = {
      session_id: SESSION,
      format_version: "1.0",
      messages: [],
      workflow: {
        task_id: "task-legacy",
        status: "Executing",
        side_effects: [],
        checkpoint: {}
      },
      counters: {},
      tool_pool_hash: TOOL_POOL_HASH,
      card_version: CARD_VERSION
    } as unknown as PersistedSession;
    writeFileSync(persister.pathFor(SESSION), JSON.stringify(preV1));

    const ctx = makeCtx({ cardActiveMode: "DangerFullAccess" });
    const outcome = await resumeSession(persister, SESSION, ctx);

    expect(outcome.kind).toBe("migrated");
    expect(outcome.session.activeMode).toBe("DangerFullAccess");
    expect(outcome.session._migrated?.from).toBe("pre-1.0");

    // The migrated session is persisted atomically — a subsequent strict
    // read now validates cleanly (activeMode is present post-migration).
    const reread = await persister.readSession(SESSION);
    expect(reread.activeMode).toBe("DangerFullAccess");
  });

  it("HR-05 cross-restart idempotency — a second resumeSession call MUST NOT re-replay committed side_effects", async () => {
    const pending: PersistedSideEffect = {
      tool: "fs__write_file",
      idempotency_key: "idk-cross-restart-01",
      phase: "pending",
      args_digest: "sha256:eeee000000000000000000000000000000000000000000000000000000000005",
      first_attempted_at: "2026-04-21T12:30:00.000Z",
      last_phase_transition_at: "2026-04-21T12:30:00.000Z"
    };
    await persister.writeSession(baseSession({ side_effects: [pending] }));

    const replayCalls: PersistedSideEffect[] = [];
    const ctx = makeCtx({ replayCalls });

    // First resume: phase pending → committed, replay called once.
    await resumeSession(persister, SESSION, ctx);
    expect(replayCalls).toHaveLength(1);

    // Second resume: phase already committed; replay MUST NOT fire.
    const outcomeB = await resumeSession(persister, SESSION, ctx);
    expect(replayCalls).toHaveLength(1); // unchanged
    expect(outcomeB.sideEffects[0]?.action).toBe("skipped");
  });

  it("unknown session_id → SessionFormatIncompatible file-missing (step 1 failure propagates)", async () => {
    const ctx = makeCtx();
    let caught: unknown;
    try {
      await resumeSession(persister, "ses_nonexistentfixture0001", ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name?: string }).name).toBe("SessionFormatIncompatible");
  });
});
