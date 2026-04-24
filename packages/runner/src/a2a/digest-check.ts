/**
 * §17.2 + §17.2.5 digest recompute helpers.
 *
 * Pure functions: `computeA2aMessagesDigest`, `computeA2aWorkflowDigest`,
 * `computeA2aResultDigest` (formula-only — §17.2.5 says result_digest is
 * shape-check-only at the wire, but callers producing transfers still need
 * the formula to compute what they'll advertise), plus the matching
 * function `checkTransferDigests` that implements the §17.2.5 transfer-
 * row cell of the per-method matrix.
 */

import { jcsBytes, sha256Hex } from "@soa-harness/core";

/** §17.2 digest form: `sha256:<64-hex-lowercase>`. */
function formatDigest(hashBytes: Buffer): string {
  return `sha256:${sha256Hex(hashBytes)}`;
}

/** SHA-256 of `JCS(messages)` per §17.2. */
export function computeA2aMessagesDigest(messages: unknown): string {
  return formatDigest(jcsBytes(messages));
}

/** SHA-256 of `JCS(workflow)` per §17.2. */
export function computeA2aWorkflowDigest(workflow: unknown): string {
  return formatDigest(jcsBytes(workflow));
}

/** SHA-256 of `JCS(result)` per §17.2. Formula-only; no wire recompute at handoff.return. */
export function computeA2aResultDigest(result: unknown): string {
  return formatDigest(jcsBytes(result));
}

/**
 * §17.2.5 handoff.transfer row — receiver-side digest check.
 *
 * Discriminated outcome the plugin maps to the right a2aError() call. The
 * retention-window check is handled by the caller (the registry's
 * `getOfferMetadata` returns null when offer state is absent OR past-
 * deadline, so the plugin only needs to pass in whatever the registry
 * returned).
 */
export type A2aTransferDigestOutcome =
  | { kind: "accept" }
  | { kind: "digest-mismatch"; fieldMismatches: Array<"messages_digest" | "workflow_digest"> }
  | { kind: "missing-offer-state" };

export interface CheckTransferDigestsInput {
  /** Live messages array delivered in handoff.transfer params. */
  messages: unknown;
  /** Live workflow object delivered in handoff.transfer params. */
  workflow: unknown;
  /**
   * Offer metadata retrieved from the receiver's registry (or null when
   * the offer was never seen, was abandoned, or the §17.2.2 transfer
   * deadline elapsed — all three collapse to `missing-offer-state` per
   * §17.2.5's restart-crash observability rule).
   */
  offerMetadata: {
    messages_digest: string;
    workflow_digest: string;
  } | null;
}

export function checkTransferDigests(input: CheckTransferDigestsInput): A2aTransferDigestOutcome {
  if (input.offerMetadata === null) {
    return { kind: "missing-offer-state" };
  }
  const computedMessages = computeA2aMessagesDigest(input.messages);
  const computedWorkflow = computeA2aWorkflowDigest(input.workflow);
  const fieldMismatches: Array<"messages_digest" | "workflow_digest"> = [];
  if (computedMessages !== input.offerMetadata.messages_digest) fieldMismatches.push("messages_digest");
  if (computedWorkflow !== input.offerMetadata.workflow_digest) fieldMismatches.push("workflow_digest");
  if (fieldMismatches.length > 0) {
    return { kind: "digest-mismatch", fieldMismatches };
  }
  return { kind: "accept" };
}
