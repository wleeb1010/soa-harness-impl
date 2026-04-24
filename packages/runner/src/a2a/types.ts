/**
 * A2A wire types per Core §17. Every closed-enum value here MUST mirror an
 * explicit normative enumeration in the spec — NO impl-side inventions.
 *
 * Spec pin (v1.3): §17.2.1 enumerates the six HandoffStatus values; §17.2.2
 * defines the per-method deadline table + env vars. This file is a faithful
 * hand-mapping. The source of truth is the spec at the PINNED_SPEC_COMMIT
 * baked into @soa-harness/schemas.
 *
 * When the spec adds a value or changes the enum shape, this file changes
 * lock-step and @soa-harness/schemas regenerates the vendored schemas.
 */

/** §17.2 digest field — `sha256:<64-hex-lowercase>`. */
export type A2aDigest = string;

/** §17.2 message shape — subset of §14.1.1 collapsed to {role, content, ...}. */
export interface A2aMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: "text" | "tool_use" | "tool_result" | "image"; [extra: string]: unknown }>;
  tool_call_id?: string;
  name?: string;
}

/** §12.1 workflow object (committed side-effects only, per §17.4). */
export interface A2aWorkflow {
  task_id: string;
  status: "Planning" | "Executing" | "Optimizing" | "Handoff" | "Blocked" | "Done";
  side_effects: Array<{ kind: string; committed_at: string; [extra: string]: unknown }>;
  checkpoint?: { sequence: number; last_event_id: string };
}

/**
 * §17.2.1 HandoffStatus — normative closed-enum of six values. Receivers of
 * any other string MUST raise HandoffRejected with reason=unknown-status.
 * Terminal states MUST NOT transition forward.
 */
export type A2aHandoffStatus =
  | "accepted"
  | "executing"
  | "completed"
  | "rejected"
  | "failed"
  | "timed-out";

/** §17.2.1 — which of the six values are terminal. */
export const A2A_TERMINAL_HANDOFF_STATUS = new Set<A2aHandoffStatus>([
  "completed",
  "rejected",
  "failed",
  "timed-out",
]);

export interface A2aHandoffOfferParams {
  task_id: string;
  summary: string;
  messages_digest: A2aDigest;
  workflow_digest: A2aDigest;
  capabilities_needed: string[];
}

export interface A2aHandoffOfferResult {
  accept: boolean;
  reason?: string;
}

export interface A2aHandoffTransferParams {
  task_id: string;
  messages: A2aMessage[];
  workflow: A2aWorkflow;
  billing_tag: string;
  correlation_id: string;
}

export interface A2aHandoffTransferResult {
  accepted_at: string;
  destination_session_id: string;
}

export interface A2aHandoffStatusParams {
  task_id: string;
}

export interface A2aHandoffStatusResult {
  status: A2aHandoffStatus;
  /** Semantics per §17.2.1 last_event_id column — null for `rejected`. */
  last_event_id: string | null;
}

export interface A2aHandoffReturnParams {
  task_id: string;
  result_digest: A2aDigest;
  final_messages: A2aMessage[];
}

export interface A2aHandoffReturnResult {
  ack: true;
}

/** Agent Card echo shape — caller receives bytes + JWS per §17.2 agent.describe. */
export interface A2aAgentDescribeResult {
  card: unknown;
  jws: string;
}

/** JSON-RPC 2.0 envelope types. */
export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  method: M;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcErrorResponse;

/**
 * §17.2.2 per-method deadlines. Values in seconds. Operator env overrides
 * replace the default when set to a positive integer; malformed or missing
 * values fall back.
 */
export interface A2aDeadlines {
  /** agent.describe default: 5 s. Env: SOA_A2A_DESCRIBE_DEADLINE_S */
  describe_s: number;
  /** handoff.offer default: 5 s. Env: SOA_A2A_OFFER_DEADLINE_S */
  offer_s: number;
  /** handoff.transfer default: 30 s. Env: SOA_A2A_TRANSFER_DEADLINE_S */
  transfer_s: number;
  /** handoff.status default: 3 s. Env: SOA_A2A_STATUS_DEADLINE_S */
  status_s: number;
  /** handoff.return default: 10 s. Env: SOA_A2A_RETURN_DEADLINE_S */
  return_s: number;
  /** Destination task execution default: 300 s. Env: SOA_A2A_TASK_DEADLINE_S */
  task_execution_s: number;
}

export const A2A_DEFAULT_DEADLINES: Readonly<A2aDeadlines> = {
  describe_s: 5,
  offer_s: 5,
  transfer_s: 30,
  status_s: 3,
  return_s: 10,
  task_execution_s: 300,
} as const;

/**
 * §17.2.2 — resolve deadlines from env + defaults. Positive-int overrides
 * replace; non-integer/negative/zero fall back to default. Missing env
 * vars obviously fall back.
 */
export function resolveA2aDeadlines(env: NodeJS.ProcessEnv = process.env): A2aDeadlines {
  const pick = (k: string, fallback: number): number => {
    const raw = env[k];
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    describe_s: pick("SOA_A2A_DESCRIBE_DEADLINE_S", A2A_DEFAULT_DEADLINES.describe_s),
    offer_s: pick("SOA_A2A_OFFER_DEADLINE_S", A2A_DEFAULT_DEADLINES.offer_s),
    transfer_s: pick("SOA_A2A_TRANSFER_DEADLINE_S", A2A_DEFAULT_DEADLINES.transfer_s),
    status_s: pick("SOA_A2A_STATUS_DEADLINE_S", A2A_DEFAULT_DEADLINES.status_s),
    return_s: pick("SOA_A2A_RETURN_DEADLINE_S", A2A_DEFAULT_DEADLINES.return_s),
    task_execution_s: pick("SOA_A2A_TASK_DEADLINE_S", A2A_DEFAULT_DEADLINES.task_execution_s),
  };
}
