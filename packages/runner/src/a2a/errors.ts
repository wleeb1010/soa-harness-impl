/**
 * A2A JSON-RPC error codes per Core §17.3.
 *
 * Every value here mirrors an explicit normative code from §17.3 — NO
 * impl-side inventions. The HandoffRejected reasons are enumerated in
 * §17.1 JWT profile + §17.2 digest rules + §17.2.1 unknown-status.
 */
import type { JsonRpcErrorResponse } from "./types.js";

export const A2A_ERROR_CODES = {
  AgentUnavailable: -32000,
  AgentCardInvalid: -32001,
  AuthFailed: -32002,
  CapabilityMismatch: -32003,
  HandoffBusy: -32050,
  HandoffRejected: -32051,
  HandoffStateIncompatible: -32052,
  TrustAnchorMismatch: -32060,
} as const;

export type A2aErrorName = keyof typeof A2A_ERROR_CODES;

/**
 * §17.1 JWT profile reasons + §17.2 digest reason + §17.2.1 unknown-status
 * reason. All land in HandoffRejected (-32051) error.data.reason.
 */
export type A2aHandoffRejectedReason =
  | "bad-alg"
  | "card-unreachable"
  | "card-version-drift"
  | "key-not-found"
  | "jti-replay"
  | "digest-mismatch"
  | "capability-mismatch"
  | "workflow-state-incompatible"
  | "unknown-status"
  | "wire-incompatibility";

export interface A2aErrorOptions {
  message?: string;
  reason?: A2aHandoffRejectedReason;
  data?: unknown;
}

/** Build a well-formed JSON-RPC 2.0 error response body. */
export function a2aError(
  id: string | number | null,
  code: A2aErrorName,
  opts: A2aErrorOptions = {},
): JsonRpcErrorResponse {
  const message = opts.message ?? code;
  const data: Record<string, unknown> = {};
  if (opts.reason !== undefined) data.reason = opts.reason;
  if (opts.data !== undefined) Object.assign(data, opts.data as Record<string, unknown>);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: A2A_ERROR_CODES[code],
      message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    },
  };
}

/** §17.2 digest shape check — `sha256:<64-hex-lowercase>`. */
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export function isWellFormedA2aDigest(d: unknown): d is string {
  return typeof d === "string" && DIGEST_RE.test(d);
}
