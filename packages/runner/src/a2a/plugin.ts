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
import { checkTransferDigests } from "./digest-check.js";
import {
  verifyA2aJwt,
  a2aJwtOutcomeToError,
  JtiReplayCache,
  type A2aJwtKeyResolver,
  type A2aJwtPayload,
} from "./jwt.js";
import type { A2aEtagDriftOutcome } from "./signer-discovery.js";
import type { TLSSocket } from "node:tls";

export interface A2aOfferMetadata {
  messages_digest: string;
  workflow_digest: string;
  /** Unix seconds at which the offer was accepted (for §17.2.5 retention-window check). */
  offeredAtS: number;
}

interface A2aTaskRow {
  status: A2aHandoffStatus;
  last_event_id: string | null;
  offer?: A2aOfferMetadata;
  /**
   * §17.2.2 task-execution deadline timestamp. Set when the task
   * transitions to `accepted` / `executing`; on handoff.status reads past
   * this point, the registry synthesizes `timed-out` (per §17.2.2 MUST
   * enforce clause) unless a terminal state has already locked in.
   */
  acceptedAtS?: number;
}

/**
 * In-memory per-task registry. Carries per-task HandoffStatus (§17.2.1)
 * AND the §17.2.5 offer-state tuple the receiver retains between
 * handoff.offer and handoff.transfer. Production impl replaces this with
 * a §12 bracket-persisted store; v1.3 does not mandate persistence
 * (restart-crash collapses to workflow-state-incompatible per §17.2.5).
 *
 * §17.2.2 task-execution-deadline enforcement: computed-on-read rather
 * than eager-transitioned. On handoff.status lookups, if the task is in
 * a pre-terminal state (accepted | executing) AND its acceptedAtS +
 * taskExecutionDeadlineS has elapsed, the registry returns a synthetic
 * `timed-out` row. The locked-in backing state is only updated when the
 * caller explicitly records a terminal state via `record()` — this keeps
 * "timed out but not yet observed" and "observed as timed out" distinct
 * in the state machine.
 */
export class A2aTaskRegistry {
  private readonly tasks = new Map<string, A2aTaskRow>();
  /** §17.2.2 handoff.transfer retention window (default 30 s). */
  private readonly retentionWindowS: number;
  /** §17.2.2 destination task-execution deadline (default 300 s). */
  private readonly taskExecutionDeadlineS: number;
  /** §17.2.2.1 pending auto-execute timer handles, keyed by task_id. */
  private readonly autoExecuteTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();

  constructor(opts: { retentionWindowS?: number; taskExecutionDeadlineS?: number } = {}) {
    this.retentionWindowS = opts.retentionWindowS ?? 30;
    this.taskExecutionDeadlineS = opts.taskExecutionDeadlineS ?? 300;
  }

  /**
   * §17.2.2.1 — schedule the accepted→executing→completed transitions at
   * N and 2N seconds respectively. Noop if timers already scheduled for
   * this task_id (duplicate-transfer clause: "MUST NOT reset or
   * reschedule"). Returns cancellation handles for the caller to abort
   * on handoff.return.
   */
  scheduleAutoExecute(taskId: string, afterS: number): void {
    if (this.autoExecuteTimers.has(taskId)) return;
    const t1 = setTimeout(() => {
      this.record(taskId, "executing", null);
    }, afterS * 1000);
    const t2 = setTimeout(() => {
      this.record(taskId, "completed", null);
      this.autoExecuteTimers.delete(taskId);
    }, 2 * afterS * 1000);
    // Both timers are "soft" — they MUST NOT keep the event loop alive
    // after the rest of the Runner shuts down. Node's Timeout.unref()
    // achieves that.
    (t1 as { unref?: () => void }).unref?.();
    (t2 as { unref?: () => void }).unref?.();
    this.autoExecuteTimers.set(taskId, [t1, t2]);
  }

  /** §17.2.2.1 — cancel pending auto-execute timers on handoff.return. */
  cancelAutoExecute(taskId: string): void {
    const timers = this.autoExecuteTimers.get(taskId);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    this.autoExecuteTimers.delete(taskId);
  }

  /** §17.2.1 — record a status. Terminal states MUST NOT transition forward. */
  record(
    taskId: string,
    status: A2aHandoffStatus,
    last_event_id: string | null,
    acceptedAtS?: number,
  ): void {
    const prev = this.tasks.get(taskId);
    if (prev && A2A_TERMINAL_HANDOFF_STATUS.has(prev.status)) {
      return;
    }
    this.tasks.set(taskId, {
      ...(prev ?? {}),
      status,
      last_event_id,
      ...(acceptedAtS !== undefined ? { acceptedAtS } : {}),
    });
  }

  /**
   * §17.2.5 — record the advertised digests + offered-at timestamp when
   * the receiver accepts a handoff.offer. Used by handoff.transfer to
   * recompute and compare.
   */
  recordOffer(taskId: string, meta: A2aOfferMetadata): void {
    const prev = this.tasks.get(taskId);
    this.tasks.set(taskId, {
      ...(prev ?? {}),
      status: prev?.status ?? "accepted",
      last_event_id: prev?.last_event_id ?? null,
      offer: meta,
    });
  }

  /**
   * Return the offer metadata iff it was recorded AND is still within the
   * §17.2.2 transfer-deadline retention window. Past-deadline offers
   * collapse to null per §17.2.5.
   */
  getOfferMetadata(taskId: string, nowS: number): A2aOfferMetadata | null {
    const row = this.tasks.get(taskId);
    if (!row || !row.offer) return null;
    if (nowS - row.offer.offeredAtS > this.retentionWindowS) return null;
    return row.offer;
  }

  /**
   * Read the task status, applying §17.2.2 task-execution-deadline
   * synthesis for pre-terminal rows whose acceptedAtS has elapsed. Passing
   * `nowS` is how the caller opts into synthesis; omitting it reads the
   * raw stored row (used internally + by tests that want deadline-free
   * views).
   */
  get(
    taskId: string,
    nowS?: number,
  ): { status: A2aHandoffStatus; last_event_id: string | null } | undefined {
    const row = this.tasks.get(taskId);
    if (!row) return undefined;
    if (
      nowS !== undefined &&
      row.acceptedAtS !== undefined &&
      !A2A_TERMINAL_HANDOFF_STATUS.has(row.status) &&
      nowS - row.acceptedAtS > this.taskExecutionDeadlineS
    ) {
      return { status: "timed-out", last_event_id: row.last_event_id };
    }
    return { status: row.status, last_event_id: row.last_event_id };
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
  /**
   * §17.1 step 4 etag-drift check. Called only after a JWT has passed
   * signature verification; returning `drift` routes to HandoffRejected
   * reason=card-version-drift per §17.1 step 4, `card-unreachable` routes
   * to reason=card-unreachable per §17.1 step 2's disjointness clause,
   * and `match` passes through. Omit to skip drift detection entirely
   * (W3 slice 1 compatibility).
   */
  checkEtagDrift?: (payload: A2aJwtPayload) => Promise<A2aEtagDriftOutcome>;
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
  /**
   * §17.2.2.1 destination-execute-hook — positive integer N seconds.
   * When set, the registry schedules accepted→executing at N seconds
   * and executing→completed at 2N seconds for every successful
   * handoff.transfer (unless handoff.return arrives first and cancels
   * the pair). Loopback-guard + deadline-collision-guard validation is
   * the CALLER's responsibility; the plugin trusts whatever positive
   * integer is passed. Server-level validation happens in server.ts
   * before this option is populated.
   */
  autoExecuteAfterS?: number;
  /**
   * Clock source (unix seconds). Defaults to wall clock. Injected by tests
   * that need to control the §17.2.5 transfer-deadline retention window.
   */
  nowFn?: () => number;
}

type AnyJsonRpcResponse = JsonRpcResponse<unknown>;

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? (m[1] ?? null) : null;
}

/**
 * Pull the mTLS client cert's DER bytes off the request when available
 * so the §17.1 step 2 peer-cert resolver can compare x5t#S256. Returns
 * undefined when the transport is not TLS, the client didn't send a
 * cert, or the Fastify inject harness is in use (tests).
 */
function extractPeerCertDer(req: FastifyRequest): Buffer | undefined {
  const sock = req.raw?.socket as TLSSocket | undefined;
  if (sock === undefined || typeof (sock as { getPeerCertificate?: unknown }).getPeerCertificate !== "function") {
    return undefined;
  }
  try {
    const info = sock.getPeerCertificate(true);
    if (!info || typeof info !== "object") return undefined;
    const raw = (info as { raw?: Buffer }).raw;
    return raw instanceof Buffer && raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export const a2aPlugin: FastifyPluginAsync<A2aPluginOptions> = async (app, opts) => {
  if (opts.bearer === undefined && opts.jwt === undefined) {
    throw new Error("a2aPlugin: at least one of { bearer, jwt } MUST be provided");
  }
  const deadlines = resolveA2aDeadlines();
  const nowFn: () => number = opts.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const registry =
    opts.taskRegistry ??
    new A2aTaskRegistry({
      retentionWindowS: deadlines.transfer_s,
      taskExecutionDeadlineS: deadlines.task_execution_s,
    });
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
      const peerCertDer = extractPeerCertDer(request);
      const outcome = await verifyA2aJwt({
        jwtCompact: presentedToken,
        audience: opts.jwt.audience,
        resolveKey: opts.jwt.resolveKey,
        jtiCache,
        ...(peerCertDer !== undefined ? { context: { peerCertDer } } : {}),
        ...(opts.jwt.clockSkewS !== undefined ? { clockSkewS: opts.jwt.clockSkewS } : {}),
        ...(opts.jwt.nowFn !== undefined ? { nowFn: opts.jwt.nowFn } : {}),
      });
      const errResponse = a2aJwtOutcomeToError(id, outcome);
      if (errResponse !== null) {
        return reply.code(200).send(errResponse);
      }
      // §17.1 step 4 etag-drift check runs only after JWT signature + claims pass.
      if (outcome.kind === "valid" && opts.jwt.checkEtagDrift !== undefined) {
        const driftOutcome = await opts.jwt.checkEtagDrift(outcome.payload);
        if (driftOutcome.kind === "drift") {
          return reply.code(200).send(
            a2aError(id, "HandoffRejected", {
              reason: "card-version-drift",
              message: `agent_card_etag drift: fetched=${driftOutcome.fetched} presented=${driftOutcome.presented}`,
            }),
          );
        }
        if (driftOutcome.kind === "card-unreachable") {
          return reply.code(200).send(
            a2aError(id, "HandoffRejected", {
              reason: "card-unreachable",
              message: driftOutcome.detail,
            }),
          );
        }
        // match — proceed.
      }
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
        response = handleHandoffOffer(id, rpc.params, registry, opts.a2aCapabilities, nowFn);
        break;
      case "handoff.transfer":
        response = handleHandoffTransfer(id, rpc.params, registry, nowFn, opts.autoExecuteAfterS);
        break;
      case "handoff.status":
        response = handleHandoffStatus(id, rpc.params, registry, nowFn);
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
  nowFn: () => number,
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
      // §17.2.5 retention MUST: record advertised digests + timestamp for
      // later recompute at handoff.transfer.
      registry.recordOffer(p.task_id, {
        messages_digest: p.messages_digest,
        workflow_digest: p.workflow_digest,
        offeredAtS: nowFn(),
      });
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
  nowFn: () => number,
  autoExecuteAfterS: number | undefined,
): JsonRpcResponse<A2aHandoffTransferResult> {
  const p = params as A2aHandoffTransferParams | undefined;
  if (!p || typeof p.task_id !== "string" || !Array.isArray(p.messages) || typeof p.workflow !== "object") {
    return a2aError(id, "HandoffRejected", {
      reason: "wire-incompatibility",
      message: "malformed transfer params (task_id, messages, workflow)",
    });
  }
  if (typeof p.billing_tag !== "string" || typeof p.correlation_id !== "string") {
    return a2aError(id, "HandoffRejected", {
      reason: "wire-incompatibility",
      message: "missing billing_tag or correlation_id",
    });
  }

  // §17.2.5 per-method digest recompute: lookup the retained offer
  // digests, recompute over the wire-delivered messages + workflow,
  // compare. Missing offer state collapses to workflow-state-incompatible
  // per §17.2.5's restart-crash observability rule.
  const offerMeta = registry.getOfferMetadata(p.task_id, nowFn());
  const digestOutcome = checkTransferDigests({
    messages: p.messages,
    workflow: p.workflow,
    offerMetadata: offerMeta,
  });
  if (digestOutcome.kind === "missing-offer-state") {
    return a2aError(id, "HandoffRejected", {
      reason: "workflow-state-incompatible",
      message: `no retained offer state for task_id=${p.task_id} (never-seen OR past §17.2.2 transfer deadline OR lost across receiver restart)`,
    });
  }
  if (digestOutcome.kind === "digest-mismatch") {
    return a2aError(id, "HandoffRejected", {
      reason: "digest-mismatch",
      message: `§17.2.5 recompute mismatch on fields: ${digestOutcome.fieldMismatches.join(", ")}`,
    });
  }

  // §17.2.5 accept path: W1 stub session creation — W2+ wires real
  // session import per §17.4. Record as `accepted` per §17.2.1 and
  // stamp the §17.2.2 task-execution-deadline start.
  const destId = `ses_${p.task_id.slice(0, 16).padEnd(16, "0")}`;
  registry.record(p.task_id, "accepted", null, nowFn());
  // §17.2.2.1 — schedule the destination execute hook if configured.
  // Callers that opt in pass a positive integer N; the registry
  // dedupes on task_id so replay-transfers won't reschedule.
  if (autoExecuteAfterS !== undefined && autoExecuteAfterS > 0) {
    registry.scheduleAutoExecute(p.task_id, autoExecuteAfterS);
  }
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
  nowFn: () => number,
): JsonRpcResponse<A2aHandoffStatusResult> {
  const p = params as A2aHandoffStatusParams | undefined;
  if (!p || typeof p.task_id !== "string") {
    return a2aError(id, "HandoffStateIncompatible", { message: "missing task_id" });
  }
  // Pass nowFn() to let the registry synthesize §17.2.2 timed-out when
  // the pre-terminal row has aged past the task-execution-deadline.
  const row = registry.get(p.task_id, nowFn());
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
  // §17.2.2.1: handoff.return cancels any pending auto-execute timers
  // for this task_id so the synthetic executing→completed transition
  // doesn't fire after the real return path has locked in completed.
  registry.cancelAutoExecute(p.task_id);
  registry.record(p.task_id, "completed", null);
  return { jsonrpc: "2.0", id, result: { ack: true } };
}
