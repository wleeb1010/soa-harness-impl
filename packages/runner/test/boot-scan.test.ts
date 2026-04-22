import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionPersister,
  scanAndResumeInProgressSessions,
  scanHasHardFailure,
  IN_PROGRESS_STATUSES,
  TERMINAL_STATUSES,
  type PersistedSession,
  type PersistedSideEffect,
  type ResumeContext,
  type ScanOutcomeEntry
} from "../src/session/index.js";
import { AuditChain } from "../src/audit/index.js";

// §12.5 L-29 resume-trigger #1 tests: startup-scan enumerates the session
// directory and invokes resumeSession for in-progress statuses only.

const FROZEN_NOW = new Date("2026-04-21T18:00:00.000Z");
const CARD_VERSION = "1.0";
const TOOL_POOL_HASH = "sha256:bootscanpool000000000000000000000000000000000000000000000000aa01";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-scan-"));
}

function session(id: string, status: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    session_id: id,
    format_version: "1.0",
    activeMode: "WorkspaceWrite",
    messages: [],
    workflow: {
      task_id: `task-${id}`,
      status,
      side_effects: [],
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: TOOL_POOL_HASH,
    card_version: CARD_VERSION,
    ...overrides
  } as PersistedSession;
}

function makeCtx(overrides: Partial<ResumeContext> & {
  replayCalls?: PersistedSideEffect[];
} = {}): ResumeContext {
  const replayCalls = overrides.replayCalls ?? [];
  return {
    currentCardVersion: overrides.currentCardVersion ?? CARD_VERSION,
    currentToolPoolHash: overrides.currentToolPoolHash ?? TOOL_POOL_HASH,
    toolCompensation: overrides.toolCompensation ?? (() => ({ canCompensate: false })),
    replayPending:
      overrides.replayPending ??
      (async (se) => {
        replayCalls.push(se);
        return null;
      }),
    compensate: overrides.compensate ?? (async () => undefined),
    cardActiveMode: overrides.cardActiveMode ?? "WorkspaceWrite",
    clock: overrides.clock ?? (() => FROZEN_NOW)
  };
}

describe("scanAndResumeInProgressSessions — L-29 resume-trigger #1", () => {
  let dir: string;
  let persister: SessionPersister;

  beforeEach(() => {
    dir = tmpDir();
    persister = new SessionPersister({ sessionDir: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("closed enums: IN_PROGRESS_STATUSES + TERMINAL_STATUSES cover the §12.1 workflow.status set", () => {
    // Defensive: these are closed sets per §12.1 status enum. If the spec
    // adds a value, adding it here is a deliberate change, not silent drift.
    expect(Array.from(IN_PROGRESS_STATUSES).sort()).toEqual([
      "Blocked",
      "Executing",
      "Handoff",
      "Optimizing",
      "Planning"
    ]);
    expect(Array.from(TERMINAL_STATUSES).sort()).toEqual(["Cancelled", "Failed", "Succeeded"]);
  });

  it("empty session directory: scan returns no outcomes + logs the zero-count line", async () => {
    const logs: string[] = [];
    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      log: (msg) => logs.push(msg)
    });
    expect(outcomes).toEqual([]);
    expect(logs.some((l) => l.includes("no persisted sessions"))).toBe(true);
  });

  it("in-progress status (Executing) with pending side_effect: resumeSession invoked, outcome=resumed", async () => {
    const pending: PersistedSideEffect = {
      tool: "fs__write_file",
      idempotency_key: "idk-scan-01",
      phase: "pending",
      args_digest: "sha256:aaaa000000000000000000000000000000000000000000000000000000000001",
      first_attempted_at: "2026-04-21T17:00:00.000Z",
      last_phase_transition_at: "2026-04-21T17:00:00.000Z"
    };
    const s = session("ses_scanfixtureexec0001", "Executing", {
      workflow: { task_id: "t", status: "Executing", side_effects: [pending], checkpoint: {} }
    } as Partial<PersistedSession>);
    await persister.writeSession(s);

    const replayCalls: PersistedSideEffect[] = [];
    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx({ replayCalls })
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe("resumed");
    expect(outcomes[0]?.status).toBe("Executing");
    expect(replayCalls).toHaveLength(1); // pending replayed

    // Post-scan file: phase advanced to committed.
    const reread = await persister.readSession("ses_scanfixtureexec0001");
    const postSe = (reread.workflow as { side_effects: PersistedSideEffect[] }).side_effects[0];
    expect(postSe?.phase).toBe("committed");
  });

  it("all five in-progress statuses: each triggers a resume call", async () => {
    const statuses = ["Planning", "Executing", "Optimizing", "Handoff", "Blocked"] as const;
    for (const [i, status] of statuses.entries()) {
      await persister.writeSession(session(`ses_scanfixtureip00${i}01`, status));
    }
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes).toHaveLength(5);
    for (const o of outcomes) {
      expect(o.action).toBe("resumed");
      expect(IN_PROGRESS_STATUSES.has(o.status)).toBe(true);
    }
  });

  it("terminal statuses (Succeeded, Failed, Cancelled) are skipped; no resume call fires", async () => {
    const statuses = ["Succeeded", "Failed", "Cancelled"] as const;
    for (const [i, status] of statuses.entries()) {
      await persister.writeSession(session(`ses_scanfixtureterm0${i}1`, status));
    }
    const replayCalls: PersistedSideEffect[] = [];
    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx({ replayCalls })
    });
    expect(outcomes).toHaveLength(3);
    for (const o of outcomes) {
      expect(o.action).toBe("skipped-terminal");
      expect(TERMINAL_STATUSES.has(o.status)).toBe(true);
    }
    expect(replayCalls).toHaveLength(0);
  });

  it("mixed scan: in-progress + terminals produce distinct outcome actions", async () => {
    await persister.writeSession(session("ses_mixfixtureexec00a1", "Executing"));
    await persister.writeSession(session("ses_mixfixtureok0000a1", "Succeeded"));
    await persister.writeSession(session("ses_mixfixtureplan00a1", "Planning"));
    await persister.writeSession(session("ses_mixfixturefail00a1", "Failed"));

    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    const byId = new Map(outcomes.map((o) => [o.session_id, o]));
    expect(byId.get("ses_mixfixtureexec00a1")?.action).toBe("resumed");
    expect(byId.get("ses_mixfixtureplan00a1")?.action).toBe("resumed");
    expect(byId.get("ses_mixfixtureok0000a1")?.action).toBe("skipped-terminal");
    expect(byId.get("ses_mixfixturefail00a1")?.action).toBe("skipped-terminal");
  });

  it("unknown workflow status (outside §12.1 enum) → failed-read schema-violation (SV-SESS-02)", async () => {
    // §12.1 workflow.status is a closed enum. A value outside both the
    // in-progress and terminal sets is a schema violation, NOT a skip —
    // route it through resume step 1's post-migration schema check.
    const weird = session("ses_unknownfixture00001", "Paused" as unknown as string);
    await persister.writeSession(weird);
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe("failed-read");
    expect(outcomes[0]?.detail).toBe("schema-violation");
  });

  it("corrupted session file is recorded as failed-read; does NOT halt scan of other sessions", async () => {
    const { writeFileSync } = await import("node:fs");
    await persister.writeSession(session("ses_scanfixturehealth01", "Executing"));
    writeFileSync(persister.pathFor("ses_scanfixturebroken01"), "{ invalid json");
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes).toHaveLength(2);
    const byId = new Map(outcomes.map((o) => [o.session_id, o]));
    expect(byId.get("ses_scanfixturehealth01")?.action).toBe("resumed");
    expect(byId.get("ses_scanfixturebroken01")?.action).toBe("failed-read");
  });

  it("audit chain integration: one resume row per outcome, each conforming to audit-records-response.schema.json", async () => {
    await persister.writeSession(session("ses_auditfixtureexec01", "Executing"));
    await persister.writeSession(session("ses_auditfixtureok0001", "Succeeded"));
    const chain = new AuditChain(() => FROZEN_NOW);
    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      chain
    });
    expect(outcomes).toHaveLength(2);
    const snapshot = chain.snapshot();
    expect(snapshot).toHaveLength(2);

    // Schema-conformance contract: every resume row must satisfy the
    // pinned /audit/records item shape so responses round-trip through
    // audit-records-response.schema.json without `additionalProperties:
    // false` violations or missing-required-field errors.
    const { registry: schemas } = await import("@soa-harness/schemas");
    const validate = schemas["audit-records-response"];
    const responseBody = {
      records: snapshot,
      has_more: false,
      runner_version: "1.0",
      generated_at: FROZEN_NOW.toISOString()
    };
    const ok = validate(responseBody);
    if (!ok) {
      console.error("validation errors:", (validate as unknown as { errors?: unknown }).errors);
    }
    expect(ok).toBe(true);

    for (const row of snapshot) {
      // Lifecycle semantics survive via `tool` sentinel + `reason`.
      expect(row["tool"]).toBe("RUNNER_RESUME");
      expect(row["subject_id"]).toBe("none");
      expect(row["handler"]).toBe("Autonomous");
      expect(row["control"]).toBe("AutoAllow");
      expect(row["decision"]).toMatch(/^(AutoAllow|Deny)$/);
      expect(String(row["reason"])).toMatch(/^resume:(resumed|migrated|skipped-terminal|skipped-unknown-status|failed-read|failed-resume):/);
      expect(row["timestamp"]).toBe(FROZEN_NOW.toISOString());
      expect(String(row["id"])).toMatch(/^aud_[A-Za-z0-9_-]{8,}$/);
      expect(String(row["args_digest"])).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("card_version drift during scan: outcome=failed-resume with reason detail", async () => {
    await persister.writeSession(session("ses_driftfixture0000001", "Executing", { card_version: "0.9-legacy" } as Partial<PersistedSession>));
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes[0]?.action).toBe("failed-resume");
    expect(outcomes[0]?.detail).toContain("CardVersionDrift");
  });

  it("SV-SESS-02 (resume path): in-progress status with schema-violating fixture throws SessionFormatIncompatible via resume step 1", async () => {
    const { writeFileSync } = await import("node:fs");
    // Claim workflow.status is an in-progress value so the scan invokes
    // resumeSession. Then break a different field (e.g., activeMode
    // outside the enum) so the post-migration schema check fails.
    const bad = {
      session_id: "ses_resumefailfixture001",
      format_version: "1.0",
      activeMode: "BogusMode", // violates the activeMode enum
      messages: [],
      workflow: {
        task_id: "task-bad",
        status: "Executing", // in-progress — routes through resumeSession
        side_effects: [],
        checkpoint: {}
      },
      counters: {},
      tool_pool_hash: TOOL_POOL_HASH,
      card_version: CARD_VERSION
    };
    writeFileSync(persister.pathFor("ses_resumefailfixture001"), JSON.stringify(bad));
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes).toHaveLength(1);
    // SessionFormatIncompatible from resume step 1 is classified as a
    // format failure (failed-read) so scanHasHardFailure trips.
    expect(outcomes[0]?.action).toBe("failed-read");
    expect(outcomes[0]?.detail).toBe("schema-violation");
  });

  it("scanHasHardFailure: corrupted session file returns true; clean scan returns false", async () => {
    const { writeFileSync } = await import("node:fs");
    // Clean + one corrupted file.
    await persister.writeSession(session("ses_cleanfixture000001aa", "Executing"));
    writeFileSync(persister.pathFor("ses_corruptfixture00001x"), "{ invalid json");
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(scanHasHardFailure(outcomes)).toBe(true);

    // Clean-only scan returns false.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const cleanDir = mkdtempSync(join(require("node:os").tmpdir(), "soa-scan-clean-"));
    const cleanP = new SessionPersister({ sessionDir: cleanDir });
    try {
      await cleanP.writeSession(session("ses_onlyfinefixture0001", "Executing"));
      const cleanOutcomes = await scanAndResumeInProgressSessions({
        persister: cleanP,
        resumeCtx: makeCtx()
      });
      expect(scanHasHardFailure(cleanOutcomes)).toBe(false);
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it("SV-SESS-09: CardVersionDrift terminates the session on disk (workflow.status=Failed)", async () => {
    const { readFileSync } = await import("node:fs");
    // Seed a session whose card_version doesn't match the runtime card.
    await persister.writeSession(
      session("ses_driftterminate0001a", "Executing", { card_version: "0.9-legacy" })
    );
    const outcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx: makeCtx(),
      chain: new AuditChain(() => FROZEN_NOW)
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.action).toBe("failed-resume");
    expect(outcomes[0]?.detail).toContain("CardVersionDrift");

    // Post-scan, the session file MUST have workflow.status = "Failed".
    const rewritten = JSON.parse(
      readFileSync(persister.pathFor("ses_driftterminate0001a"), "utf8")
    ) as { workflow: { status: string }; _termination_reason?: string };
    expect(rewritten.workflow.status).toBe("Failed");
    expect(rewritten._termination_reason).toBe("CardVersionDrift");
  });

  it("tool_pool_hash drift: outcome=failed-resume reason=tool-pool-hash-mismatch", async () => {
    await persister.writeSession(
      session("ses_tpoolfixture0000001", "Executing", {
        tool_pool_hash: "sha256:stale0000000000000000000000000000000000000000000000000000000000aa"
      } as Partial<PersistedSession>)
    );
    const outcomes = await scanAndResumeInProgressSessions({ persister, resumeCtx: makeCtx() });
    expect(outcomes[0]?.action).toBe("failed-resume");
    expect(outcomes[0]?.detail).toContain("ToolPoolStale");
    expect(outcomes[0]?.detail).toContain("tool-pool-hash-mismatch");
  });
});
