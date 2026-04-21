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

import { SessionPersister, SessionFormatIncompatible } from "./persist.js";
import { resumeSession, type ResumeContext, CardVersionDrift } from "./resume.js";
import { ToolPoolStale } from "../registry/index.js";
import type { AuditChain } from "../audit/index.js";

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

      if (TERMINAL_STATUSES.has(status)) {
        outcomes.push({ session_id: sessionId, status, action: "skipped-terminal" });
        continue;
      }
      if (!IN_PROGRESS_STATUSES.has(status)) {
        outcomes.push({
          session_id: sessionId,
          status,
          action: "skipped-unknown-status",
          detail: `status "${status}" not in §12.1 enum`
        });
        continue;
      }

      try {
        const resumed = await resumeSession(opts.persister, sessionId, opts.resumeCtx);
        outcomes.push({
          session_id: sessionId,
          status,
          action: resumed.kind === "migrated" ? "migrated" : "resumed",
          detail: `${resumed.sideEffects.length} side_effect(s) processed`
        });
      } catch (err) {
        outcomes.push({
          session_id: sessionId,
          status,
          action: "failed-resume",
          detail: describeResumeFailure(err)
        });
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

  if (opts.chain) {
    const nowIso = clock().toISOString();
    for (const outcome of outcomes) {
      opts.chain.append({
        kind: "session-resume",
        timestamp: nowIso,
        session_id: outcome.session_id,
        status: outcome.status,
        action: outcome.action,
        detail: outcome.detail ?? ""
      });
    }
  }

  return outcomes;
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

function summarize(outcomes: ScanOutcomeEntry[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.action, (counts.get(o.action) ?? 0) + 1);
  if (outcomes.length === 0) return "no sessions scanned";
  const parts: string[] = [];
  for (const [action, n] of counts) parts.push(`${action}=${n}`);
  return `scan complete: ${parts.sort().join(", ")} (total=${outcomes.length})`;
}
