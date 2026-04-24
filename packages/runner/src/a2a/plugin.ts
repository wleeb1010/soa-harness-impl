/**
 * §17 Agent2Agent wire-protocol HTTP plugin. Mounts POST /a2a/v1 as a
 * JSON-RPC 2.0 endpoint dispatching to the five §17.2 methods.
 *
 * v1.3 W1 scope: wire framing + auth stub + handler scaffolding. Semantic
 * implementations (real state transfer, JWT verification, mTLS) land in
 * W2-W4 per L-68.
 *
 * Auth: bearer-only for W1. The §17.1 JWT profile (mTLS + signing-key
 * discovery + jti replay + agent_card_etag) is implemented in W3. Until
 * then adopters pass a session bearer (for loopback testing) and a
 * `SOA_A2A_REQUIRE_JWT_MODE` env toggle MAY be set to "enforce" once the
 * JWT middleware ships to short-circuit the bearer fallback.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { a2aError, isWellFormedA2aDigest } from "./errors.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  A2aHandoffOfferParams,
  A2aHandoffOfferResult,
  A2aHandoffTransferParams,
  A2aHandoffTransferResult,
  A2aHandoffStatusParams,
  A2aHandoffStatusResult,
  A2aHandoffReturnParams,
  A2aHandoffReturnResult,
  A2aAgentDescribeResult,
  A2aHandoffStatus,
} from "./types.js";
import { resolveA2aDeadlines, A2A_TERMINAL_HANDOFF_STATUS } from "./types.js";
import { matchA2aCapabilities } from "./matching.js";
import {
  verifyA2aJwt,
  a2aJwtOutcomeToError,
  JtiReplayCache,
  type A2aJwtKeyResolver,
} from "./jwt.js";

/**
 * In-memory per-task status tracker for W1. Production impl replaces this
 * with a §12 bracket-persisted store; for now callers set status via
 * recordHandoffStatus() so SV-A2A-15 can assert transitions without
 * requiring the full workflow machinery.
 */
export class A2aTaskRegistry {
  private readonly tasks = new Map<string, { status: A2aHandoffStatus; last_event_id: string | null }>();

  /** §17.2.1 — record a status. Terminal states MUST NOT transition forward. */
  record(taskId: string, status: A2aHandoffStatus, last_event_id: string | null): void {
    const prev = this.tasks.get(taskId);
    if (prev && A2A_TERMINAL_HANDOFF_STATUS.has(prev.status)) {
      // Monotonicity: terminal states lock in per §17.2.1.
      return;
    }
    this.tasks.set(taskId, { status, last_event_id });
  }

  get(taskId: string): { status: A2aHandoffStatus; last_event_id: string | null } | undefined {
    return this.tasks.get(taskId);
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }
}

export interface A2aJwtAuthOptions {
  /** The callee's own URL; JWT `aud` claim MUST equal this. */
  audience: string;
  /** §17.1 step 2 signing-key discovery function. */
  resolveKey: A2aJwtKeyResolver;
  /**
   * §17.1 step 3 jti replay cache. When omitted the plugin creates a
   * per-registration in-memory cache; supply an external one when the
   * Runner clusters or when tests need to inject a clock.
   */
  jtiCache?: JtiReplayCache;
  /** Acceptable forward clock skew on `iat` (seconds). Default: 60. */
  clockSkewS?: number;
  /** Clock source (unix seconds). Default: wall clock. */
  nowFn?: () => number;
}

export interface A2aPluginOptions {
  /**
   * W1 bearer token. MAY be supplied alongside or instead of `jwt`:
   *   - `jwt` alone  → production §17.1 mode.
   *   - `bearer` alone → W1 smoke-test mode (tests, local dev).
   *   - both present → `jwt` takes precedence on every request; `bearer`
   *     is ignored.
   * At least one of the two MUST be provided; the plugin throws at
   * registration if both are absent.
   */
  bearer?: string;
  /**
   * §17.1 JWT normative profile. When present, bearer is ignored and the
   * Authorization header is treated as a compact JWT verified per
   * §17.1 steps 1-3 (slice-1 scope; steps 2-Agent-Card-fetch and 4 etag-
   * drift land in W3 slice 2).
   */
  jwt?: A2aJwtAuthOptions;
  /**
   * Agent Card shipping with this Runner — echoed back as agent.describe
   * result. Signed by the same key that signs /.well-known/agent-card.jws
   * so §17.2.4's per-response JWS-verify invariant holds by construction.
   */
  card: unknown;
  /** Detached JWS over JCS(card) per §6.1.1 Agent Card JWS profile. */
  cardJws: string;
  /** In-memory task registry (or caller's store that conforms to the shape). */
  taskRegistry?: A2aTaskRegistry;
  /**
   * §17.2.3 receiver-side A2A capability surface. Undefined OR empty array
   * both mean "serves no A2A capabilities" (§17.2.3 three-encodings rule).
   * Production adopters SHOULD source this from their own Agent Card's
   * `a2a.capabilities` field so the advertised surface and the matched
   * surface cannot drift.
   */
  a2aCapabilities?: string[];
}

type AnyJsonRpcResponse = JsonRpcResponse<unknown>;

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? (m[1] ?? null) : null;
}

export const a2aPlugin: FastifyPluginAsync<A2aPluginOptions> = async (app, opts) => {
  if (opts.bearer === undefined && opts.jwt === undefined) {
    throw new Error("a2aPlugin: at least one of { bearer, jwt } MUST be provided");
  }
  const registry = opts.taskRegistry ?? new A2aTaskRegistry();
  const deadlines = resolveA2aDeadlines();
  // W3 slice 1: a lazily-initialised jti cache the plugin owns when the
  // caller didn't supply one. Prevents each request from seeing an empty
  // cache and silently accepting replays.
  const jtiCache = opts.jwt?.jtiCache ?? new JtiReplayCache(opts.jwt?.nowFn);

  app.post("/a2a/v1", async (request, reply) => {
    // JSON-RPC 2.0 envelope + auth + method dispatch. The envelope check
    // happens first so bad-shape requests return the canonical -32600
    // Invalid Request rather than 401.
    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "no-store");

    const body = request.body as unknown;
    if (body === null || typeof body !== "object" || (body as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      return reply.code(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request — expected JSON-RPC 2.0 envelope" },
      });
    }

    const rpc = body as JsonRpcRequest<string, unknown>;
    const id = rpc.id ?? null;

    // §17.1 auth. JWT takes precedence when configured (§17.1 normative
    // mode); bearer is the W1 smoke-test fallback.
    const presentedToken = extractBearer(request);
    if (opts.jwt !== undefined) {
      if (!presentedToken) {
        return reply.code(200).send(a2aError(id, "AuthFailed", { message: "missing Authorization: Bearer <jwt>" }));
      }
      const outcome = await verifyA2aJwt({
        jwtCompact: presentedToken,
        audience: opts.jwt.audience,
        resolveKey: opts.jwt.resolveKey,
        jtiCache,
        ...(opts.jwt.clockSkewS !== undefined ? { clockSkewS: opts.jwt.clockSkewS } : {}),
        ...(opts.jwt.nowFn !== undefined ? { nowFn: opts.jwt.nowFn } : {}),
      });
      const errResponse = a2aJwtOutcomeToError(id, outcome);
      if (errResponse !== null) {
        return reply.code(200).send(errResponse);
      }
      // JWT valid — proceed.
    } else {
      // Bearer fallback.
      if (!presentedToken || presentedToken !== opts.bearer) {
        return reply.code(200).send(a2aError(id, "AuthFailed", { message: "bearer-mismatch-or-missing" }));
      }
    }

    let response: AnyJsonRpcResponse;
    switch (rpc.method) {
      case "agent.describe":
        response = handleAgentDescribe(id, opts);
        break;
      case "handoff.offer":
        response = handleHandoffOffer(id, rpc.params, registry, opts.a2aCapabilities);
        break;
      case "handoff.transfer":
        response = handleHandoffTransfer(id, rpc.params, registry);
        break;
      case "handoff.status":
        response = handleHandoffStatus(id, rpc.params, registry);
        break;
      case "handoff.return":
        response = handleHandoffReturn(id, rpc.params, registry);
        break;
      default:
        response = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
    }

    // Deadlines enforcement is wired per-method in W2+; in W1 we surface the
    // resolved values via a debug header so smoke tests can inspect without
    // a new surface. Header is for diagnostics only — not a normative API.
    reply.header("x-a2a-task-deadline-s", String(deadlines.task_execution_s));
    return reply.code(200).send(response);
  });
};

function handleAgentDescribe(
  id: string | number | null,
  opts: A2aPluginOptions,
): JsonRpcResponse<A2aAgentDescribeResult> {
  return {
    jsonrpc: "2.0",
    id,
    result: { card: opts.card, jws: opts.cardJws },
  };
}

function handleHandoffOffer(
  id: string | number | null,
  params: unknown,
  registry: A2aTaskRegistry,
  a2aCapabilities: string[] | undefined,
): JsonRpcResponse<A2aHandoffOfferResult> {
  const p = params as A2aHandoffOfferParams | undefined;
  if (!p || typeof p.task_id !== "string" || typeof p.summary !== "string") {
    return a2aError(id, "HandoffRejected", {
      reason: "wire-incompatibility",
      message: "malformed offer params (task_id, summary)",
    });
  }
  if (!isWellFormedA2aDigest(p.messages_digest) || !isWellFormedA2aDigest(p.workflow_digest)) {
    return a2aError(id, "HandoffRejected", { reason: "digest-mismatch", message: "digest not sha256:<64hex>" });
  }

  // §17.2.3 truth table + validation.
  const outcome = matchA2aCapabilities(p.capabilities_needed, a2aCapabilities);
  switch (outcome.kind) {
    case "accept":
      return { jsonrpc: "2.0", id, result: { accept: true } };
    case "reject-no-capabilities":
      return {
        jsonrpc: "2.0",
        id,
        result: { accept: false, reason: "no-a2a-capabilities-advertised" },
      };
    case "wire-incompatible":
      return a2aError(id, "HandoffRejected", {
        reason: "wire-incompatibility",
        message: outcome.detail,
      });
    case "capability-mismatch":
      return a2aError(id, "CapabilityMismatch", {
        message: "capabilities_needed not a subset of a2a.capabilities",
        data: { missing_capabilities: outcome.missing },
      });
  }
}

function handleHandoffTransfer(
  id: string | number | null,
  params: unknown,
  registry: A2aTaskRegistry,
): JsonRpcResponse<A2aHandoffTransferResult> {
  const p = params as A2aHandoffTransferParams | undefined;
  if (!p || typeof p.task_id !== "string" || !Array.isArray(p.messages) || typeof p.workflow !== "object") {
    return a2aError(id, "HandoffRejected", {
      reason: "workflow-state-incompatible",
      message: "malformed transfer params",
    });
  }
  if (typeof p.billing_tag !== "string" || typeof p.correlation_id !== "string") {
    return a2aError(id, "HandoffRejected", {
      reason: "workflow-state-incompatible",
      message: "missing billing_tag or correlation_id",
    });
  }
  // W1: W2 wires real session creation + state import. For now we mint a
  // synthetic destination_session_id and record the task as `accepted` per
  // §17.2.1.
  const destId = `ses_${p.task_id.slice(0, 16).padEnd(16, "0")}`;
  registry.record(p.task_id, "accepted", null);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      accepted_at: new Date().toISOString(),
      destination_session_id: destId,
    },
  };
}

function handleHandoffStatus(
  id: string | number | null,
  params: unknown,
  registry: A2aTaskRegistry,
): JsonRpcResponse<A2aHandoffStatusResult> {
  const p = params as A2aHandoffStatusParams | undefined;
  if (!p || typeof p.task_id !== "string") {
    return a2aError(id, "HandoffStateIncompatible", { message: "missing task_id" });
  }
  const row = registry.get(p.task_id);
  if (!row) {
    return a2aError(id, "HandoffStateIncompatible", {
      message: "unknown task_id — was handoff.transfer called for this task?",
    });
  }
  return {
    jsonrpc: "2.0",
    id,
    result: { status: row.status, last_event_id: row.last_event_id },
  };
}

function handleHandoffReturn(
  id: string | number | null,
  params: unknown,
  registry: A2aTaskRegistry,
): JsonRpcResponse<A2aHandoffReturnResult> {
  const p = params as A2aHandoffReturnParams | undefined;
  if (!p || typeof p.task_id !== "string" || !isWellFormedA2aDigest(p.result_digest)) {
    return a2aError(id, "HandoffRejected", {
      reason: "digest-mismatch",
      message: "malformed return params or result_digest",
    });
  }
  // W1: record terminal status. W2 wires digest recomputation + compare.
  registry.record(p.task_id, "completed", null);
  return { jsonrpc: "2.0", id, result: { ack: true } };
}
