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

export interface A2aPluginOptions {
  /**
   * Bearer token accepted by the a2a surface for W1. In W3 this is replaced
   * by the §17.1 JWT profile. Required; set to a non-empty string.
   */
  bearer: string;
  /**
   * Agent Card shipping with this Runner — echoed back as agent.describe
   * result. W2 work wires a signed JWS; W1 echoes the card object with a
   * placeholder JWS string the validator schema-probes for wire presence
   * but does not cryptographically verify.
   */
  card: unknown;
  /** Placeholder JWS for agent.describe responses. W2 replaces with real signed JWS. */
  cardJws: string;
  /** In-memory task registry (or caller's store that conforms to the shape). */
  taskRegistry?: A2aTaskRegistry;
}

type AnyJsonRpcResponse = JsonRpcResponse<unknown>;

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? (m[1] ?? null) : null;
}

export const a2aPlugin: FastifyPluginAsync<A2aPluginOptions> = async (app, opts) => {
  const registry = opts.taskRegistry ?? new A2aTaskRegistry();
  const deadlines = resolveA2aDeadlines();

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

    // §17.1 auth — W1 bearer mode. W3 adds the JWT profile.
    const bearer = extractBearer(request);
    if (!bearer || bearer !== opts.bearer) {
      return reply.code(200).send(a2aError(id, "AuthFailed", { message: "bearer-mismatch-or-missing" }));
    }

    let response: AnyJsonRpcResponse;
    switch (rpc.method) {
      case "agent.describe":
        response = handleAgentDescribe(id, opts);
        break;
      case "handoff.offer":
        response = handleHandoffOffer(id, rpc.params, registry);
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
): JsonRpcResponse<A2aHandoffOfferResult> {
  const p = params as A2aHandoffOfferParams | undefined;
  if (!p || typeof p.task_id !== "string" || typeof p.summary !== "string") {
    return a2aError(id, "HandoffRejected", { reason: "digest-mismatch", message: "malformed offer params" });
  }
  if (!isWellFormedA2aDigest(p.messages_digest) || !isWellFormedA2aDigest(p.workflow_digest)) {
    return a2aError(id, "HandoffRejected", { reason: "digest-mismatch", message: "digest not sha256:<64hex>" });
  }
  if (!Array.isArray(p.capabilities_needed)) {
    return a2aError(id, "CapabilityMismatch", { message: "capabilities_needed missing" });
  }
  // W1 always accepts — W2 wires real capability-matching against the Agent
  // Card. The acceptance here is enough to exercise SV-A2A-04's offer-accept
  // path; the offer-reject path lands in W2 with the card matcher.
  return { jsonrpc: "2.0", id, result: { accept: true } };
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
