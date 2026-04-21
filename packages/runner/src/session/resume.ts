/**
 * §12.5 Resume Algorithm.
 *
 * `resume_session(session_id)` MUST:
 *   1. Read session file; validate format_version == "1.0" else
 *      `SessionFormatIncompatible`.
 *   2. Verify `card_version` matches the currently-served Agent Card;
 *      on mismatch: `StopReason::CardVersionDrift`.
 *   3. Verify `tool_pool_hash` still resolves (§11.3); on mismatch:
 *      `ToolPoolStale reason=tool-pool-hash-mismatch`.
 *   4. For each `side_effects[i].phase`:
 *        pending    → replay with the recorded idempotency key (→ committed)
 *        committed  → skip
 *        inflight   → compensate if tool supports it (→ compensated);
 *                     else mark `compensated` with a `ResumeCompensationGap` note
 *        compensated → skip (already terminal)
 *
 * After step 4 the session is persisted atomically via SessionPersister so
 * the next read reflects the post-resume state — closing HR-05's "committed
 * does NOT replay" property across further restarts.
 *
 * Covers HR-04, HR-05, SV-SESS-08, SV-SESS-09, SV-SESS-10.
 */

import { registry as schemaRegistry } from "@soa-harness/schemas";
import { ToolPoolStale } from "../registry/index.js";
import { SessionPersister, SessionFormatIncompatible } from "./persist.js";
import { migratePre1SessionFile, type PersistedSession, type MigratedSession } from "./migrate.js";
import type { Capability } from "../permission/types.js";

/** Closed-enum stop reasons raised by the resume algorithm. */
export class CardVersionDrift extends Error {
  readonly stopReason = "CardVersionDrift" as const;
  readonly sessionId: string;
  readonly expected: string;
  readonly actual: string;
  constructor(sessionId: string, expected: string, actual: string) {
    super(`CardVersionDrift session=${sessionId} expected=${expected} actual=${actual}`);
    this.name = "CardVersionDrift";
    this.sessionId = sessionId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Side-effect shape as it lives inside a PersistedSession.workflow. */
export interface PersistedSideEffect {
  tool: string;
  idempotency_key: string;
  phase: "pending" | "inflight" | "committed" | "compensated";
  args_digest?: string;
  result_digest?: string;
  first_attempted_at?: string;
  last_phase_transition_at?: string;
  /** Non-normative marker emitted by §12.5 step 4 when compensation can't run. */
  _resume_note?: "ResumeCompensationGap";
}

/** Per-side_effect action taken during resume — surfaced to the caller for audit. */
export interface ResumedSideEffect {
  index: number;
  tool: string;
  idempotency_key: string;
  action: "replayed" | "skipped" | "compensated" | "compensation-gap";
}

/** Capabilities/invokers the resume algorithm delegates to the caller. */
export interface ToolCompensationSupport {
  /** Whether the tool supports a compensating action (undo) for a partial execution. */
  canCompensate: boolean;
}

export interface ResumeContext {
  /** The currently served Agent Card's version — §12.5 step 2 comparand. */
  currentCardVersion: string;
  /** The currently-resolved Tool Registry hash — §12.5 step 3 comparand. */
  currentToolPoolHash: string;
  /** Lookup for a tool's compensation capability. Unknown tool → treat as no-compensate. */
  toolCompensation: (toolName: string) => ToolCompensationSupport | undefined;
  /**
   * Replay a `pending` side_effect using its recorded idempotency_key.
   * Returns an optional new `result_digest` to persist in the committed row.
   * Tool-side dedupe MUST accept the replay (§12.2); if the tool refuses
   * (idempotency cache evicted), the caller MAY return `null` to leave
   * `result_digest` unset while still marking the side_effect committed.
   */
  replayPending: (side_effect: PersistedSideEffect) => Promise<string | null>;
  /**
   * Execute the compensating action for an `inflight` side_effect whose tool
   * supports it. Errors propagate — the caller decides whether to retry.
   */
  compensate: (side_effect: PersistedSideEffect) => Promise<void>;
  /** Agent Card's activeMode — used by pre-1.0 migration when the file predates L-20. */
  cardActiveMode: Capability;
  /** Clock for transition timestamps. */
  clock: () => Date;
}

export type ResumeOutcomeKind = "resumed" | "migrated";

export interface ResumeOutcome {
  kind: ResumeOutcomeKind;
  session: MigratedSession;
  sideEffects: ResumedSideEffect[];
}

/** §12.5 resume algorithm entry point. */
export async function resumeSession(
  persister: SessionPersister,
  session_id: string,
  ctx: ResumeContext
): Promise<ResumeOutcome> {
  // Step 1 — read + format_version check (lenient; full schema run comes
  // AFTER migration so pre-1.0 files pass through).
  const raw = await persister.readSessionForResume(session_id);

  // Session-id sanity: guard against a session file whose contents disagree
  // with the path we loaded from. This catches operator misfiling early.
  if (raw.session_id !== session_id) {
    throw new SessionFormatIncompatible(
      persister.pathFor(session_id),
      "schema-violation",
      `session_id mismatch: path=${session_id} body=${raw.session_id}`
    );
  }

  const migrated = migratePre1SessionFile(raw, ctx.cardActiveMode);
  const kind: ResumeOutcomeKind = migrated._migrated?.from === "pre-1.0" ? "migrated" : "resumed";

  // §12.5 step 1 strictness: post-migration, the file MUST conform to the
  // pinned session.schema.json. A value outside the §12.1 workflow.status
  // enum or any other schema drift raises SessionFormatIncompatible. Pre-1.0
  // migration runs first so files missing activeMode pass this check after
  // the default has been filled in.
  const validator = schemaRegistry["session"];
  if (!validator(migrated)) {
    throw new SessionFormatIncompatible(
      persister.pathFor(session_id),
      "schema-violation",
      JSON.stringify(validator.errors ?? [])
    );
  }

  // Step 2 — card_version drift.
  const actualCardVersion = typeof migrated.card_version === "string" ? migrated.card_version : "";
  if (actualCardVersion !== ctx.currentCardVersion) {
    throw new CardVersionDrift(session_id, ctx.currentCardVersion, actualCardVersion);
  }

  // Step 3 — tool_pool_hash drift.
  const actualToolPoolHash = typeof migrated.tool_pool_hash === "string" ? migrated.tool_pool_hash : "";
  if (actualToolPoolHash !== ctx.currentToolPoolHash) {
    throw new ToolPoolStale(session_id, "tool-pool-hash-mismatch");
  }

  // Step 4 — per-side_effect action.
  const workflow = migrated.workflow as
    | undefined
    | { side_effects?: PersistedSideEffect[]; [k: string]: unknown };
  const sideEffects = Array.isArray(workflow?.side_effects) ? workflow!.side_effects! : [];

  const actions: ResumedSideEffect[] = [];
  for (let idx = 0; idx < sideEffects.length; idx++) {
    const se = sideEffects[idx]!;
    const nowIso = ctx.clock().toISOString();

    if (se.phase === "pending") {
      const newResultDigest = await ctx.replayPending(se);
      se.phase = "committed";
      if (typeof newResultDigest === "string") se.result_digest = newResultDigest;
      se.last_phase_transition_at = nowIso;
      actions.push({
        index: idx,
        tool: se.tool,
        idempotency_key: se.idempotency_key,
        action: "replayed"
      });
    } else if (se.phase === "committed") {
      // HR-05 invariant: committed side_effects MUST NOT replay.
      actions.push({
        index: idx,
        tool: se.tool,
        idempotency_key: se.idempotency_key,
        action: "skipped"
      });
    } else if (se.phase === "inflight") {
      const comp = ctx.toolCompensation(se.tool);
      if (comp?.canCompensate) {
        await ctx.compensate(se);
        se.phase = "compensated";
        se.last_phase_transition_at = nowIso;
        actions.push({
          index: idx,
          tool: se.tool,
          idempotency_key: se.idempotency_key,
          action: "compensated"
        });
      } else {
        // §12.5 step 4: "else mark `compensated` with a ResumeCompensationGap note."
        se.phase = "compensated";
        se._resume_note = "ResumeCompensationGap";
        se.last_phase_transition_at = nowIso;
        actions.push({
          index: idx,
          tool: se.tool,
          idempotency_key: se.idempotency_key,
          action: "compensation-gap"
        });
      }
    } else {
      // Already compensated — no action.
      actions.push({
        index: idx,
        tool: se.tool,
        idempotency_key: se.idempotency_key,
        action: "skipped"
      });
    }
  }

  // Atomically persist the post-resume state so a subsequent resume sees
  // the new phases (HR-05 idempotency across restarts).
  await persister.writeSession(migrated as PersistedSession);

  return { kind, session: migrated, sideEffects: actions };
}
