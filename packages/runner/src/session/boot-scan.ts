/**
 * §12.5 Resume-trigger #1 (L-29 Normative MUST): Runner startup scan.
 *
 * After trust bootstrap + BEFORE the public listener opens, enumerate the
 * session directory and invoke `resumeSession` for every session whose
 * `workflow.status` is in the in-progress set
 * {Planning, Executing, Optimizing, Handoff, Blocked}.
 *
 * Terminal statuses {Succeeded, Failed, Cancelled} are skipped — no
 * side_effects can still be pending by definition.
 *
 * Each outcome (resumed / skipped / migrated / failed) is recorded in the
 * audit log so operators see the auto-resume trail post-restart.
 *
 * The scan's blast radius is bounded: failures to read or resume a single
 * session file are logged + audited but do NOT halt the scan (one
 * corrupted session MUST NOT block 1000 healthy ones from coming back
 * online). Unreadable files are logged with their SessionFormatIncompatible
 * reason and surfaced to `/ready` via the readiness probe if persistence
 * is also unwritable.
 */

import { createHash, randomBytes } from "node:crypto";
import { jcs } from "@soa-harness/core";
import { SessionPersister, SessionFormatIncompatible } from "./persist.js";
import {
  resumeSession,
  type ResumeContext,
  type ResumedSideEffect,
  CardVersionDrift
} from "./resume.js";
import { ToolPoolStale } from "../registry/index.js";
import type { AuditChain } from "../audit/index.js";
import type { StreamEventEmitter } from "../stream/index.js";

/** Non-terminal workflow statuses — sessions to auto-resume. */
export const IN_PROGRESS_STATUSES = new Set<string>([
  "Planning",
  "Executing",
  "Optimizing",
  "Handoff",
  "Blocked"
]);

/** Terminal workflow statuses — sessions to skip. */
export const TERMINAL_STATUSES = new Set<string>(["Succeeded", "Failed", "Cancelled"]);

export interface ScanOutcomeEntry {
  session_id: string;
  status: string;
  /**
   * Action taken:
   *   - resumed: resumeSession ran, side_effects replayed as needed
   *   - migrated: resumeSession ran on a pre-1.0 file (default activeMode from card)
   *   - skipped-terminal: workflow.status is terminal
   *   - skipped-unknown-status: workflow.status is outside the §12.1 enum
   *   - failed-read: readSessionForResume threw SessionFormatIncompatible
   *   - failed-resume: resumeSession threw (CardVersionDrift / ToolPoolStale / other)
   */
  action:
    | "resumed"
    | "migrated"
    | "skipped-terminal"
    | "skipped-unknown-status"
    | "failed-read"
    | "failed-resume";
  detail?: string;
  /**
   * §10.5.6 L-50 BI-impl-ext — granted activeMode snapshot from the
   * persisted session file. Used to derive retention_class on the
   * RUNNER_RESUME audit row so every record carries the retention
   * tag per spec. Optional because failed-read outcomes have no
   * readable file.
   */
  activeMode?: string;
}

export interface ScanAndResumeOptions {
  persister: SessionPersister;
  resumeCtx: ResumeContext;
  /** When present, each outcome is appended to the audit chain as kind=session-resume. */
  chain?: AuditChain;
  /** Logger for operator-visible lines. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Clock for audit timestamps. Falls back to resumeCtx.clock. */
  clock?: () => Date;
  /**
   * §14.1 / §14.5.5 Finding AE — when present, emit a `CrashEvent`
   * StreamEvent for every session whose persisted state carried an
   * open bracket (≥1 `pending` or `inflight` side_effect prior to
   * resume). The event lands in the per-session ring buffer and is
   * readable via /events/recent (§14.5) — under `admin:read` scope
   * post-restart since the session's original bearer is gone.
   */
  emitter?: StreamEventEmitter;
}

/**
 * Scan the session directory and auto-resume in-progress sessions. Returns
 * the outcome list (caller may inspect for operator UI or test assertions);
 * audit-log append happens as a side effect of this call when a chain is
 * supplied.
 */
export async function scanAndResumeInProgressSessions(
  opts: ScanAndResumeOptions
): Promise<ScanOutcomeEntry[]> {
  const log = opts.log ?? ((msg) => console.log(msg));
  const clock = opts.clock ?? opts.resumeCtx.clock;
  const ids = await opts.persister.listSessionIds();
  const outcomes: ScanOutcomeEntry[] = [];

  if (ids.length === 0) {
    log(`[boot-scan] no persisted sessions to resume`);
    return outcomes;
  }

  log(`[boot-scan] discovered ${ids.length} persisted session(s); scanning for in-progress work`);

  for (const sessionId of ids) {
    try {
      const raw = await opts.persister.readSessionForResume(sessionId);
      const status = readWorkflowStatus(raw);
      const activeMode = readSessionActiveMode(raw);

      if (TERMINAL_STATUSES.has(status)) {
        outcomes.push({
          session_id: sessionId,
          status,
          action: "skipped-terminal",
          ...(activeMode !== undefined ? { activeMode } : {})
        });
        continue;
      }
      // Any non-terminal value MUST be in the §12.1 IN_PROGRESS enum; an
      // unknown string is a schema violation. Route through resumeSession
      // so the post-migration schema check in step 1 catches it as
      // SessionFormatIncompatible — classified under failed-read so the
      // bin's scanHasHardFailure trips and refuses to open the listener.
      // (A bogus status isn't "unknown" — it's invalid.)

      try {
        // Finding AE / SV-STR-10 — snapshot the pre-resume side_effects
        // before resumeSession mutates pending→committed / inflight→
        // compensated. last_committed_event_id in the CrashEvent payload
        // MUST reflect the state that existed at the moment the Runner
        // was killed, not the post-recovery state.
        const preResumeSideEffects = readSideEffectsSnapshot(raw);

        const resumed = await resumeSession(opts.persister, sessionId, opts.resumeCtx);
        outcomes.push({
          session_id: sessionId,
          status,
          action: resumed.kind === "migrated" ? "migrated" : "resumed",
          detail: `${resumed.sideEffects.length} side_effect(s) processed`,
          ...(activeMode !== undefined ? { activeMode } : {})
        });

        // An "open bracket" at boot-scan time means the pre-resume
        // session carried ≥1 side_effect whose phase was `pending` or
        // `inflight`. Sessions that had only `committed` + `compensated`
        // rows pre-resume replayed nothing — no crash recovery happened
        // — and MUST NOT emit a CrashEvent.
        if (opts.emitter !== undefined) {
          const openBracketActions = resumed.sideEffects.filter(
            (se) =>
              se.action === "replayed" ||
              se.action === "compensated" ||
              se.action === "compensation-gap"
          );
          if (openBracketActions.length > 0) {
            const payload = buildCrashEventPayload(
              resumed.session,
              preResumeSideEffects,
              openBracketActions
            );
            opts.emitter.emit({
              session_id: sessionId,
              type: "CrashEvent",
              payload,
              ...(typeof payload["workflow_state_id"] === "string"
                ? { workflow_state_id: payload["workflow_state_id"] as string }
                : {})
            });
          }
        }
      } catch (err) {
        // SessionFormatIncompatible from step 1 is treated as a format
        // failure (failed-read reason=<specific>), so scanHasHardFailure
        // trips; CardVersionDrift / ToolPoolStale stay as failed-resume.
        if (err instanceof SessionFormatIncompatible) {
          outcomes.push({
            session_id: sessionId,
            status,
            action: "failed-read",
            detail: err.reason,
            ...(activeMode !== undefined ? { activeMode } : {})
          });
          continue;
        }
        outcomes.push({
          session_id: sessionId,
          status,
          action: "failed-resume",
          detail: describeResumeFailure(err),
          ...(activeMode !== undefined ? { activeMode } : {})
        });
        // §12.5 step 2: CardVersionDrift terminates the session. Mark the
        // file Failed so a subsequent scan treats it as skipped-terminal
        // rather than retrying the drifted comparison indefinitely. Best-
        // effort; a write failure is logged via onRefreshError semantics
        // but doesn't abort the scan.
        if (err instanceof CardVersionDrift) {
          try {
            await markSessionFailedOnDisk(opts.persister, sessionId, clock);
          } catch (writeErr) {
            log(
              `[boot-scan] failed to mark ${sessionId} as Failed post-CardVersionDrift: ${String(writeErr)}`
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof SessionFormatIncompatible) {
        outcomes.push({
          session_id: sessionId,
          status: "<unreadable>",
          action: "failed-read",
          detail: err.reason
        });
      } else {
        outcomes.push({
          session_id: sessionId,
          status: "<unreadable>",
          action: "failed-read",
          detail: (err as Error).message
        });
      }
    }
  }

  // Log a single summary line + append one audit row per outcome.
  const summary = summarize(outcomes);
  log(`[boot-scan] ${summary}`);

  // Append one schema-conformant audit row per outcome. The chain is the
  // same log /audit/records serves, and that response's record items are
  // pinned to audit-records-response.schema.json with additionalProperties:
  // false + a fixed required-field set inherited from §10.5. Resume lifecycle
  // rows must therefore project onto the decision-record schema: sentinel
  // `tool`/`subject_id`/`capability`/`control`/`handler` fields, real
  // sha256 args_digest, and the lifecycle semantics (resumed / migrated /
  // failed-*) carried in `reason`. Downstream consumers recover the kind
  // by matching on tool=="RUNNER_RESUME".
  if (opts.chain) {
    for (const outcome of outcomes) {
      opts.chain.append(buildResumeAuditBody(outcome));
    }
  }

  return outcomes;
}

/**
 * Map a resume-scan outcome onto the §10.5 audit-record shape so the chain
 * stays conformant to audit-records-response.schema.json. Non-decision
 * fields are sentinels; the lifecycle payload lives in `reason`.
 */
function buildResumeAuditBody(outcome: ScanOutcomeEntry): Record<string, unknown> {
  const decisionForAction: Record<ScanOutcomeEntry["action"], "AutoAllow" | "Deny"> = {
    resumed: "AutoAllow",
    migrated: "AutoAllow",
    "skipped-terminal": "AutoAllow",
    "skipped-unknown-status": "AutoAllow",
    "failed-read": "Deny",
    "failed-resume": "Deny"
  };
  // Deterministic fingerprint: sha256(JCS({session_id, action, status})).
  // Same input → same digest across restarts (useful for diffing resume
  // trails). We avoid putting the detail string into the fingerprint
  // because it may carry transient state (e.g., error messages).
  const digestInput = {
    session_id: outcome.session_id,
    action: outcome.action,
    status: outcome.status
  };
  const argsDigest =
    "sha256:" + createHash("sha256").update(jcs(digestInput)).digest("hex");
  const reason =
    outcome.detail !== undefined && outcome.detail.length > 0
      ? `resume:${outcome.action}:${outcome.status} (${outcome.detail})`
      : `resume:${outcome.action}:${outcome.status}`;
  // §10.5.6 L-50 BI-impl-ext — retention_class carries through resume-
  // lifecycle rows so every chain record is tagged uniformly. Pre-
  // resume activeMode from the persisted session is the canonical
  // source; we fall back to standard-90d when the file was unreadable.
  const retentionClass =
    outcome.activeMode === "DangerFullAccess" ? "dfa-365d" : "standard-90d";
  return {
    id: `aud_${randomBytes(6).toString("hex")}`,
    session_id: outcome.session_id,
    subject_id: "none",
    tool: "RUNNER_RESUME",
    args_digest: argsDigest,
    capability: "ReadOnly",
    control: "AutoAllow",
    handler: "Autonomous",
    decision: decisionForAction[outcome.action],
    reason,
    signer_key_id: "",
    retention_class: retentionClass
  };
}

/** Pull activeMode from a freshly-read PersistedSession shape. */
function readSessionActiveMode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const mode = (raw as { activeMode?: unknown }).activeMode;
  return typeof mode === "string" ? mode : undefined;
}

/** Inspect a persisted session object for its workflow.status field. */
function readWorkflowStatus(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const workflow = (raw as { workflow?: unknown }).workflow;
    if (workflow && typeof workflow === "object") {
      const status = (workflow as { status?: unknown }).status;
      if (typeof status === "string") return status;
    }
  }
  return "<missing>";
}

function describeResumeFailure(err: unknown): string {
  if (err instanceof CardVersionDrift) return `CardVersionDrift(expected=${err.expected},actual=${err.actual})`;
  if (err instanceof ToolPoolStale) return `ToolPoolStale(reason=${err.reason})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * §12.5 step 2 termination: write the drifted session back with
 * workflow.status="Failed". Uses the lenient read path so a pre-1.0 file
 * still loads, then migrates + patches + writes. If the read itself fails
 * (corrupted), the caller's best-effort swallow handles it.
 */
async function markSessionFailedOnDisk(
  persister: SessionPersister,
  sessionId: string,
  clock: () => Date
): Promise<void> {
  const raw = await persister.readSessionForResume(sessionId);
  const workflow = raw.workflow as { status?: string } | undefined;
  if (workflow) {
    workflow.status = "Failed";
  } else {
    (raw as { workflow: unknown }).workflow = {
      task_id: `bootstrap-${sessionId}`,
      status: "Failed",
      side_effects: [],
      checkpoint: {}
    };
  }
  (raw as { _terminated_at?: string })._terminated_at = clock().toISOString();
  (raw as { _termination_reason?: string })._termination_reason = "CardVersionDrift";
  await persister.writeSession(raw);
}

/**
 * True when any scan outcome represents a hard format incompatibility that
 * the operator MUST see before the Runner accepts new traffic. Bin inspects
 * this post-scan to decide whether to exit non-zero (§12.5 L-29 trigger).
 */
export function scanHasHardFailure(outcomes: ScanOutcomeEntry[]): boolean {
  return outcomes.some(
    (o) => o.action === "failed-read" && o.detail !== undefined && HARD_FAILURE_REASONS.has(o.detail)
  );
}

const HARD_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "corrupted-json",
  "partial-write-detected",
  "schema-violation",
  "bad-format-version"
]);

/** Shape of the raw pre-resume side_effect snapshot passed to the payload builder. */
interface PreResumeSideEffectSnapshot {
  phase: string;
  idempotency_key: string;
}

/**
 * Pull a defensive copy of the workflow.side_effects phases + keys
 * from a freshly-read persisted session. Runs BEFORE resumeSession
 * mutates the in-place object so `last_committed_event_id` in a
 * CrashEvent reflects the pre-crash state, not the post-recovery one.
 */
function readSideEffectsSnapshot(raw: unknown): PreResumeSideEffectSnapshot[] {
  if (!raw || typeof raw !== "object") return [];
  const workflow = (raw as { workflow?: unknown }).workflow;
  if (!workflow || typeof workflow !== "object") return [];
  const arr = (workflow as { side_effects?: unknown }).side_effects;
  if (!Array.isArray(arr)) return [];
  const out: PreResumeSideEffectSnapshot[] = [];
  for (const row of arr) {
    if (row && typeof row === "object") {
      const phase = (row as { phase?: unknown }).phase;
      const key = (row as { idempotency_key?: unknown }).idempotency_key;
      if (typeof phase === "string" && typeof key === "string") {
        out.push({ phase, idempotency_key: key });
      }
    }
  }
  return out;
}

/**
 * Build a §14.1.1 CrashEvent payload from the resumed session + the
 * pre-resume side_effects snapshot + the subset of resume actions that
 * indicate an open bracket existed. Required fields per schema:
 * reason, workflow_state_id, last_committed_event_id. Optional
 * stack_hint carries a concise description of the observed bracket
 * state — validators read it for operator forensics without relying
 * on the exact string shape.
 */
function buildCrashEventPayload(
  session: Record<string, unknown>,
  preResumeSideEffects: readonly PreResumeSideEffectSnapshot[],
  openBracketActions: readonly ResumedSideEffect[]
): Record<string, unknown> {
  const workflow = (session["workflow"] ?? {}) as { task_id?: unknown };
  const workflowStateId =
    typeof workflow.task_id === "string" && workflow.task_id.length > 0
      ? workflow.task_id
      : typeof session["session_id"] === "string"
        ? (session["session_id"] as string)
        : "unknown";

  // Last committed event PRE-resume: the most recent side_effect whose
  // phase was `committed` at the time the Runner was killed. Post-
  // resume state is inappropriate here — resume flips pending→
  // committed, which would surface a just-replayed row as "last
  // committed" even though it was open at the crash instant.
  const lastCommitted = [...preResumeSideEffects]
    .reverse()
    .find((se) => se.phase === "committed");
  const lastCommittedEventId =
    lastCommitted !== undefined && lastCommitted.idempotency_key.length > 0
      ? lastCommitted.idempotency_key
      : "none";

  const tallies = openBracketActions.reduce<Record<string, number>>((acc, se) => {
    acc[se.action] = (acc[se.action] ?? 0) + 1;
    return acc;
  }, {});
  const stackHint =
    `resume-with-open-bracket: ` +
    Object.entries(tallies)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");

  return {
    reason: "resume-with-open-bracket",
    workflow_state_id: workflowStateId,
    last_committed_event_id: lastCommittedEventId,
    stack_hint: stackHint.slice(0, 4096)
  };
}

function summarize(outcomes: ScanOutcomeEntry[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.action, (counts.get(o.action) ?? 0) + 1);
  if (outcomes.length === 0) return "no sessions scanned";
  const parts: string[] = [];
  for (const [action, n] of counts) parts.push(`${action}=${n}`);
  return `scan complete: ${parts.sort().join(", ")} (total=${outcomes.length})`;
}
