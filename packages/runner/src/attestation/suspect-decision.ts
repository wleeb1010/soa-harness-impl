/**
 * §10.6.5 L-48 Finding BE-retroactive — SuspectDecision flagging.
 *
 * On handler-kid revocation, scan the audit chain back 24h and for
 * every decision-row whose `signer_key_id === kid` append a new
 * admin-row carrying `decision:"SuspectDecision"`, `referenced_audit_id:
 * <original-id>`, `reason:"kid-revoked-24h-window"`. Original rows
 * stay immutable (WORM); the flag lives in the appended rows that
 * reference them.
 *
 * Called from HandlerCrlPoller.onHandlerRevoked so every revocation
 * path (production CRL or SOA_BOOTSTRAP_REVOCATION_FILE handler_kid
 * entry) triggers the retroactive pass exactly once per kid.
 */

import { randomBytes } from "node:crypto";
import type { AuditChain, AuditRecord } from "../audit/chain.js";
import type { Clock } from "../clock/index.js";

export interface AppendSuspectDecisionsOptions {
  chain: AuditChain;
  kid: string;
  clock: Clock;
  /** Window size in milliseconds. §10.6.5 pins 24h. */
  windowMs?: number;
  /** RFC 3339 revocation moment. Defaults to clock(). */
  revokedAtIso?: string;
}

export interface SuspectDecisionResult {
  kid: string;
  flagged: number;
  appended_ids: string[];
}

/**
 * Scan + append. Safe to call repeatedly — matching rows will be
 * re-flagged (operators may want a fresh pass after reloading the
 * revocation file), but the caller typically invokes this exactly
 * once per newly-observed revocation.
 */
export function appendSuspectDecisionsForKid(
  opts: AppendSuspectDecisionsOptions
): SuspectDecisionResult {
  const { chain, kid, clock } = opts;
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const revokedAtIso = opts.revokedAtIso ?? clock().toISOString();
  const revokedAtMs = Date.parse(revokedAtIso);
  const cutoffMs = Number.isFinite(revokedAtMs) ? revokedAtMs - windowMs : Number.NEGATIVE_INFINITY;

  const all: readonly AuditRecord[] = chain.snapshot();
  const appendedIds: string[] = [];
  for (const row of all) {
    if (row["signer_key_id"] !== kid) continue;
    const tsStr = typeof row["timestamp"] === "string" ? (row["timestamp"] as string) : "";
    const tsMs = Date.parse(tsStr);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) continue;
    const referencedId = typeof row["id"] === "string" ? (row["id"] as string) : "";
    if (referencedId.length === 0) continue;
    // Skip rows that are themselves SuspectDecision admin-rows.
    if (row["decision"] === "SuspectDecision") continue;

    const suspectId = `aud_${randomBytes(6).toString("hex")}`;
    const sessionId = typeof row["session_id"] === "string" ? (row["session_id"] as string) : "none";
    const subjectId = typeof row["subject_id"] === "string" ? (row["subject_id"] as string) : "none";
    chain.append({
      id: suspectId,
      session_id: sessionId,
      subject_id: subjectId,
      decision: "SuspectDecision",
      reason: "kid-revoked-24h-window",
      referenced_audit_id: referencedId
    });
    appendedIds.push(suspectId);
  }
  return { kid, flagged: appendedIds.length, appended_ids: appendedIds };
}
