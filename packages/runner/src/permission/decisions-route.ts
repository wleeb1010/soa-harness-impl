import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { jcsBytes } from "@soa-harness/core";
import type { AuditChain, AuditSink } from "../audit/index.js";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { ToolRegistry } from "../registry/index.js";
import type { Control } from "../registry/types.js";
import type { MarkerEmitter } from "../markers/index.js";
import type { StreamEventEmitter } from "../stream/index.js";
import { runHook, type HookOutcome, type HookReentrancyTracker } from "../hook/index.js";
import type { BudgetTracker } from "../budget/index.js";
import {
  SessionPersister,
  SessionFormatIncompatible,
  type PersistedSession,
  type PersistedSideEffect
} from "../session/index.js";
import {
  verifyPda,
  PdaVerifyFailed,
  type HandlerKeyResolver,
  type KidRevokedCheck
} from "../attestation/index.js";
import { resolvePermissionForQuery, type PermissionsResolveResponse } from "./resolve-for-query.js";
import type { SessionStore } from "./session-store.js";
import type { Capability } from "./types.js";

export interface PermissionsDecisionsRouteOptions {
  registry: ToolRegistry;
  sessionStore: SessionStore;
  chain: AuditChain;
  readiness: ReadinessProbe;
  clock: Clock;
  activeCapability: Capability;
  toolRequirements?: Record<string, Control>;
  policyEndpoint?: string;
  /** Resolves PDA signing keys — consumed when the resolver says Prompt. */
  resolvePdaVerifyKey?: HandlerKeyResolver;
  /** Optional CRL check for PDA kid revocation. */
  isPdaKidRevoked?: KidRevokedCheck;
  runnerVersion?: string;
  /** §10.3.2 rate limit — 30 rpm per bearer. */
  requestsPerMinute?: number;
  /**
   * Optional §10.5.1 audit-sink state machine. When present, the route:
   *   - refuses Mutating/Destructive tools with 403 PermissionDenied
   *     reason=audit-sink-unreachable in `unreachable-halt` (ReadOnly
   *     traffic continues);
   *   - calls `sink.recordAuditRow(written)` after every hash-chain append
   *     so the row is buffered to `<sessionDir>/audit/pending/` in
   *     `degraded-buffering` / `unreachable-halt`.
   * Omit to preserve M1 behavior (no sink integration).
   */
  sink?: AuditSink;
  /**
   * §12.2 L-31 bracket-persist bundle. When all four are set, each
   * /permissions/decisions call goes through the full bracket-persist
   * protocol: read session → append pending side_effect → write (with
   * PENDING_WRITE_DONE marker) → dispatch (TOOL_INVOKE_START/DONE
   * markers) → audit (AUDIT_APPEND_DONE via chain.markers) → transition
   * committed + write (COMMITTED_WRITE_DONE marker).
   *
   * Idempotency: a client-supplied `idempotency_key` in the request body
   * that matches an already-committed side_effect on the same session
   * returns the cached decision + audit_record_id without appending a
   * second audit row.
   *
   * Absent → backwards-compat M2 behavior (in-memory chain only; no
   * side_effect row; no bracket markers). Existing decision tests keep
   * passing unchanged.
   */
  persister?: SessionPersister;
  markers?: MarkerEmitter;
  /** Tool pool hash embedded when synthesizing a missing session file. */
  toolPoolHash?: string;
  /** Card version embedded when synthesizing a missing session file. */
  cardVersion?: string;
  /**
   * M3-T2 StreamEvent emitter. When present, a §14.1 PermissionDecision
   * event fires after successful commit (both fresh + replay). The
   * prompt_id is synthesized from the audit_record_id so the UI can
   * correlate the decision back to the chain; scope is "once" for M2/M3
   * headless calls (per §14.1.1 PermissionDecision payload schema).
   */
  emitter?: StreamEventEmitter;
  /**
   * M3-T6 §15 hooks pipeline. When preToolUseCommand is set, the hook
   * fires BEFORE the resolver — Deny short-circuits to 403
   * PermissionDenied reason=hook-deny (no audit row, no side_effect);
   * Prompt forces the final decision into Prompt regardless of the
   * resolver's output. When postToolUseCommand is set, the hook fires
   * AFTER the commit write and is advisory (its decision is logged
   * but does not mutate the response body — §15.3 PostToolUse role
   * per the Runner is acknowledge/error/retry).
   */
  hookConfig?: {
    preToolUseCommand?: readonly string[];
    postToolUseCommand?: readonly string[];
    turnIdFn?: () => string;
  };
  /**
   * §13.1 budget tracker — `recordTurn()` fires after every successful
   * committed decision so `/budget/projection` advances in lockstep with
   * the session's turn count. In M3 the LLM-dispatch layer hasn't wired
   * yet, so the per-turn token cost comes from `budgetPerTurnEstimate`
   * (default 512). When a real dispatcher lands, replace this with the
   * actual API-reported token counts.
   */
  budgetTracker?: BudgetTracker;
  /** Per-turn token estimate fed to BudgetTracker.recordTurn. Default 512. */
  budgetPerTurnEstimate?: number;
  /**
   * §15 reentrancy guard (Finding N / SV-HOOK-08). When set, every
   * PreToolUse/PostToolUse runHook call registers its child PID with
   * the tracker for the owning session; inbound requests carrying an
   * `x-soa-hook-pid` header that names an in-flight PID are rejected
   * with 403 hook-reentrancy AND the owning session is terminated
   * (SessionEnd{stop_reason:"HookReentrancy"} + bearer revocation).
   * Omit to preserve pre-Finding-N behavior.
   */
  hookReentrancy?: HookReentrancyTracker;
}

const WINDOW_MS = 60_000;

class BearerLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: Clock) {}

  consume(bearerHash: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    const fresh = (this.windows.get(bearerHash) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      this.windows.set(bearerHash, fresh);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000)) };
    }
    fresh.push(t);
    this.windows.set(bearerHash, fresh);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? match[1] ?? null : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function auditRecordId(): string {
  // aud_ + 12 hex chars → matches ^aud_[A-Za-z0-9_-]{8,}$
  return `aud_${randomBytes(6).toString("hex")}`;
}

/**
 * Maps a resolver decision to the implicit "what a compatible PDA would carry".
 * A PDA whose canonical-decision.decision disagrees with this mapping is a
 * forgery attempt and MUST return 403 pda-decision-mismatch.
 *
 *   AutoAllow           → "allow"  (can't present a "deny" PDA to override)
 *   Deny / *Denied      → "deny"   (can't present an "allow" PDA to override)
 *   Prompt              → either   (handler decides; PDA.decision is accepted as-is)
 *   ConfigPrecedence…   → "deny"   (same reasoning)
 */
function resolverImpliesPdaDecision(
  resolverDecision: PermissionsResolveResponse["decision"]
): "allow" | "deny" | "either" {
  switch (resolverDecision) {
    case "AutoAllow":
      return "allow";
    case "Prompt":
      return "either";
    case "Deny":
    case "CapabilityDenied":
    case "ConfigPrecedenceViolation":
      return "deny";
  }
}

interface DecisionRequestBody {
  tool: unknown;
  session_id: unknown;
  args_digest: unknown;
  pda?: unknown;
}

/**
 * §12.2 L-31 client-supplied idempotency key. Passed via the `Idempotency-Key`
 * HTTP header (standard REST convention) rather than a body field — the
 * pinned permission-decision-request.schema.json enforces
 * additionalProperties:false on the body, so extending the body is a spec
 * change. Re-submit with the same session_id + Idempotency-Key returns the
 * cached decision + audit_record_id without appending a second audit row.
 */
function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const hdr = request.headers["idempotency-key"];
  if (typeof hdr !== "string") return undefined;
  const trimmed = hdr.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Non-normative cache fields embedded on a side_effect for idempotency lookup. */
interface CachedDecisionFields {
  _audit_record_id: string;
  _audit_this_hash: string;
  _decision: string;
  _resolved_capability: string;
  _resolved_control: string;
  _reason: string;
  _handler_accepted: boolean;
  _recorded_at: string;
}

type CachedSideEffect = PersistedSideEffect & Partial<CachedDecisionFields>;

async function loadOrSynthesizeSession(
  persister: SessionPersister,
  sessionId: string,
  sessionRecord: { activeMode: Capability },
  toolPoolHash: string,
  cardVersion: string,
  clock: Clock
): Promise<PersistedSession> {
  try {
    return await persister.readSession(sessionId);
  } catch (err) {
    if (err instanceof SessionFormatIncompatible && err.reason === "file-missing") {
      const nowIso = clock().toISOString();
      return {
        session_id: sessionId,
        format_version: "1.0",
        activeMode: sessionRecord.activeMode,
        created_at: nowIso,
        messages: [],
        workflow: {
          task_id: `bootstrap-${sessionId}`,
          status: "Planning",
          side_effects: [],
          checkpoint: {}
        },
        counters: {},
        tool_pool_hash: toolPoolHash,
        card_version: cardVersion
      } as PersistedSession;
    }
    throw err;
  }
}

export const permissionsDecisionsPlugin: FastifyPluginAsync<
  PermissionsDecisionsRouteOptions
> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new BearerLimiter(opts.requestsPerMinute ?? 30, opts.clock);
  const validateBody = schemaRegistry["permission-decision-request"];

  app.post("/permissions/decisions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    // §15 Finding N / SV-HOOK-08 — reentrancy guard. Requests carrying a
    // `x-soa-hook-pid` header that matches any currently-in-flight
    // PreToolUse or PostToolUse child PID are blocked BEFORE auth /
    // readiness / rate-limit gates: the misbehaving hook would otherwise
    // consume a decision slot and corrupt the bracket-persist state. The
    // owning session (not necessarily the one named in the body) is
    // terminated with a §14.1 SessionEnd event and its bearer is
    // revoked so subsequent requests from the hook fail at auth.
    if (opts.hookReentrancy) {
      const hdr = request.headers["x-soa-hook-pid"];
      const raw = Array.isArray(hdr) ? hdr[0] : hdr;
      const candidatePid = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(candidatePid) && candidatePid > 0) {
        const owningSession = opts.hookReentrancy.sessionForPid(candidatePid);
        if (owningSession !== null) {
          if (opts.emitter) {
            opts.emitter.emit({
              session_id: owningSession,
              type: "SessionEnd",
              payload: { stop_reason: "HookReentrancy" }
            });
          }
          // Revoke the bearer so any subsequent request from the hook
          // (including the one we're about to 403) fails at auth on
          // retry. `revoke` is idempotent.
          const store = opts.sessionStore as unknown as { revoke?: (id: string) => void };
          if (typeof store.revoke === "function") store.revoke(owningSession);
          return reply.code(403).send({
            error: "PermissionDenied",
            reason: "hook-reentrancy",
            detail:
              `request carries x-soa-hook-pid=${candidatePid} which matches an in-flight hook ` +
              `for session ${owningSession}; session terminated with stop_reason=HookReentrancy`
          });
        }
      }
    }

    // 503 pre-boot (§10.3.2 inherits /ready gate)
    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    // Auth: session bearer. Per §10.3.2 L-22 closed enum, a bearer scoped to
    // a different session returns 403 session-bearer-mismatch (surfaced via
    // sessionStore.validate below); a bearer missing the decide scope returns
    // 403 insufficient-scope.
    const bearer = extractBearer(request);
    if (!bearer) {
      return reply.code(401).send({ error: "missing-or-invalid-bearer" });
    }
    const bearerHash = sha256Hex(bearer);

    // Rate limit
    const rl = limiter.consume(bearerHash);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    // Body shape validation
    const body = (request.body ?? {}) as DecisionRequestBody;
    if (!validateBody(body)) {
      return reply.code(400).send({ error: "malformed-request" });
    }
    const tool = body.tool as string;
    const sessionId = body.session_id as string;
    // `argsDigest` is mutable: §15 PreToolUse replace_args re-fingerprints
    // the substituted args and the new digest flows through bracket-persist +
    // chain.append + audit row. `argsDigestBefore` is captured pre-hook so
    // the §14.1 PreToolUseOutcome payload can report both.
    let argsDigest = body.args_digest as string;
    const argsDigestBefore = argsDigest;
    const pdaJws = typeof body.pda === "string" ? body.pda : null;

    // Session: must exist, bearer must match, scope must include
    // permissions:decide:<session_id> (T-03).
    if (!opts.sessionStore.exists(sessionId)) {
      return reply.code(404).send({ error: "unknown-session" });
    }
    if (!opts.sessionStore.validate(sessionId, bearer)) {
      return reply.code(403).send({ error: "session-bearer-mismatch" });
    }
    const sessionRecord = opts.sessionStore.getRecord(sessionId);
    if (!sessionRecord?.canDecide) {
      return reply.code(403).send({
        error: "insufficient-scope",
        detail: `bearer lacks permissions:decide:${sessionId} scope (grant via request_decide_scope:true on POST /sessions)`
      });
    }

    // Tool lookup
    const toolEntry = opts.registry.lookup(tool);
    if (!toolEntry) {
      return reply.code(404).send({ error: "unknown-tool" });
    }

    // §10.5.1 — audit sink unreachable-halt: refuse Mutating/Destructive tool
    // invocations BEFORE the resolver runs. ReadOnly continues. The refusal
    // itself is not audited (there is nowhere durable to write the record;
    // that's the whole premise of the halt state). Orchestrators observe
    // the transition via /audit/sink-events + /ready=503.
    if (opts.sink?.shouldRefuseMutating(toolEntry.risk_class)) {
      return reply.code(403).send({
        error: "PermissionDenied",
        reason: "audit-sink-unreachable"
      });
    }

    // §13.2 pre-call projection-over-budget check (HR-02 / SV-BUD-02..07).
    // Runs BEFORE the §15 PreToolUse hook + bracket-persist pending write so
    // a doomed turn doesn't consume an audit slot or spin up hook children.
    // When the §13.1 p95 * 1.15 projection + cumulative-so-far would push
    // past maxTokensPerRun, terminate the session with
    // SessionEnd{stop_reason:"BudgetExhausted"}, revoke the bearer, and
    // return 403. The current turn is refused (no audit row, no side_effect).
    if (
      opts.budgetTracker !== undefined &&
      opts.budgetTracker.has(sessionId) &&
      opts.budgetTracker.wouldExhaust(sessionId)
    ) {
      terminateForBudgetExhausted(
        sessionId,
        opts.emitter,
        opts.sessionStore,
        opts.budgetTracker
      );
      return reply.code(403).send({
        error: "PermissionDenied",
        reason: "budget-exhausted",
        detail:
          "§13.2 pre-call enforcement: projected next-turn tokens would exceed maxTokensPerRun; session terminated with stop_reason=BudgetExhausted"
      });
    }

    // §15 PreToolUse hook: fires BEFORE the resolver. Deny short-circuits
    // to 403 with no audit row / no side_effect. Prompt forces the final
    // decision's user-facing outcome into Prompt even when the resolver
    // would have AutoAllow'd. §15.3 stdout.replace_args substitutes the
    // args BEFORE the resolver runs; the re-fingerprinted digest flows
    // through bracket-persist + audit + stream. Finding L / SV-HOOK-05.
    //
    // §14.1 tool_call_id correlates the Pre/PostToolUseOutcome pair
    // against a single decision lifecycle.
    const toolCallId = `tc_${randomBytes(6).toString("hex")}`;
    let preHookForcedPrompt = false;
    /**
     * Parked until after PermissionDecision emits (§14.1 ordering:
     * PermissionDecision → PreToolUseOutcome → ToolResult →
     * PostToolUseOutcome). On hook Deny we emit synchronously and return
     * 403 without parking.
     */
    let pendingPreToolUseOutcome:
      | {
          outcome: "allow" | "replace_args";
          reason?: string;
          args_digest_before: string;
          args_digest_after?: string;
        }
      | null = null;
    if (opts.hookConfig?.preToolUseCommand && opts.hookConfig.preToolUseCommand.length > 0) {
      const turnId = opts.hookConfig.turnIdFn?.() ?? `turn_${randomBytes(6).toString("hex")}`;
      let trackedPreHookPid: number | null = null;
      const outcome = await runHook({
        command: opts.hookConfig.preToolUseCommand,
        stdin: {
          hook: "PreToolUse",
          session_id: sessionId,
          turn_id: turnId,
          tool: { name: toolEntry.name, risk_class: toolEntry.risk_class, args_digest: argsDigest },
          capability: sessionRecord.activeMode,
          handler: "Interactive"
        },
        ...(opts.hookReentrancy
          ? {
              onSpawn: (pid: number): void => {
                trackedPreHookPid = pid;
                opts.hookReentrancy!.begin(sessionId, pid);
              },
              onExit: (): void => {
                if (trackedPreHookPid !== null) {
                  opts.hookReentrancy!.end(sessionId, trackedPreHookPid);
                  trackedPreHookPid = null;
                }
              }
            }
          : {})
      });
      if (outcome.decision === "Deny") {
        // §14.1 PreToolUseOutcome: emit BEFORE the 403 return so the
        // validator sees the hook's view of the invocation even on the
        // deny-short-circuit path. No PermissionDecision event fires on
        // this path because no audit row is appended.
        if (opts.emitter) {
          const denyReason = outcome.stdout?.reason ?? outcome.reason ?? "hook-deny";
          opts.emitter.emit({
            session_id: sessionId,
            type: "PreToolUseOutcome",
            payload: {
              tool_call_id: toolCallId,
              tool_name: toolEntry.name,
              outcome: "deny",
              reason: denyReason,
              args_digest_before: argsDigestBefore
            }
          });
        }
        return reply.code(403).send({
          error: "PermissionDenied",
          reason: "hook-deny",
          ...(outcome.reason ? { hook_reason: outcome.reason } : {}),
          ...(outcome.stdout?.reason ? { hook_detail: outcome.stdout.reason } : {})
        });
      }
      if (outcome.decision === "Prompt") preHookForcedPrompt = true;

      // §15.3 stdout.replace_args: canonicalize the substituted args
      // (JCS-RFC-8785) and re-fingerprint. The new digest replaces
      // `argsDigest` so every downstream step (bracket-persist pending
      // row, chain.append args_digest field, audit row) uses the post-
      // substitution value. `argsDigestBefore` remains pinned for the
      // PreToolUseOutcome payload.
      const replaceArgs = outcome.stdout?.replace_args;
      if (replaceArgs !== undefined) {
        // sha256 of JCS-RFC-8785 canonical bytes — same fingerprint
        // scheme the spec uses for every other args_digest.
        const digestAfter = `sha256:${createHash("sha256").update(jcsBytes(replaceArgs)).digest("hex")}`;
        argsDigest = digestAfter;
        pendingPreToolUseOutcome = {
          outcome: "replace_args",
          ...(outcome.stdout?.reason ? { reason: outcome.stdout.reason } : {}),
          args_digest_before: argsDigestBefore,
          args_digest_after: digestAfter
        };
      } else {
        // Allow / Prompt path: record the hook's "allow" outcome so the
        // §14.1 PreToolUseOutcome fires after PermissionDecision.
        pendingPreToolUseOutcome = {
          outcome: "allow",
          ...(outcome.stdout?.reason
            ? { reason: outcome.stdout.reason }
            : outcome.decision === "Prompt"
              ? { reason: "hook-forced-prompt" }
              : {}),
          args_digest_before: argsDigestBefore
        };
      }
    }

    // §12.2 L-31 bracket-persist: when the persister bundle is wired, read
    // the session file + check for an idempotency cache hit before running
    // the decision pipeline. Cache hits return the original decision +
    // audit_record_id without appending a second audit row.
    const bracketWired =
      opts.persister !== undefined &&
      opts.markers !== undefined &&
      opts.toolPoolHash !== undefined &&
      opts.cardVersion !== undefined;

    let bracketSession: PersistedSession | null = null;
    let sideEffectIndex = -1;
    let bracketIdempotencyKey: string | undefined;

    const clientIdempotencyKey = extractIdempotencyKey(request);

    if (bracketWired) {
      bracketSession = await loadOrSynthesizeSession(
        opts.persister!,
        sessionId,
        sessionRecord,
        opts.toolPoolHash!,
        opts.cardVersion!,
        opts.clock
      );
      if (clientIdempotencyKey !== undefined) {
        const workflow = bracketSession.workflow as { side_effects?: CachedSideEffect[] } | undefined;
        const ses = Array.isArray(workflow?.side_effects) ? workflow!.side_effects! : [];
        const hit = ses.find(
          (se) => se.idempotency_key === clientIdempotencyKey && se.phase === "committed" && typeof se._audit_record_id === "string"
        );
        if (hit) {
          return reply.code(201).send({
            decision: hit._decision,
            resolved_capability: hit._resolved_capability,
            resolved_control: hit._resolved_control,
            reason: hit._reason,
            audit_record_id: hit._audit_record_id,
            audit_this_hash: hit._audit_this_hash,
            handler_accepted: hit._handler_accepted,
            runner_version: runnerVersion,
            recorded_at: hit._recorded_at,
            idempotency_key: hit.idempotency_key,
            replayed: true
          });
        }
      }
      bracketIdempotencyKey = clientIdempotencyKey ?? randomUUID();

      // Append pending side_effect + atomic write with PENDING_WRITE_DONE marker.
      const workflow = bracketSession.workflow as {
        side_effects: PersistedSideEffect[];
        [k: string]: unknown;
      };
      if (!Array.isArray(workflow.side_effects)) workflow.side_effects = [];
      const nowIso = opts.clock().toISOString();
      sideEffectIndex = workflow.side_effects.length;
      workflow.side_effects.push({
        tool: toolEntry.name,
        idempotency_key: bracketIdempotencyKey,
        phase: "pending",
        args_digest: argsDigest,
        first_attempted_at: nowIso,
        last_phase_transition_at: nowIso
      });
      await opts.persister!.writeSession(bracketSession, {
        markerPhase: { kind: "pending", side_effect: sideEffectIndex }
      });
      opts.markers!.toolInvokeStart(sessionId, sideEffectIndex);
    }

    // Resolver (§10.3 steps 1-4) — forgery-resistant source of decision.
    // MUST use session.activeMode, not the Agent Card's, per Week 3 day 2 rule.
    const resolverResponse = resolvePermissionForQuery({
      tool: toolEntry,
      capability: sessionRecord.activeMode,
      ...(opts.toolRequirements?.[toolEntry.name] !== undefined
        ? { toolRequirement: opts.toolRequirements[toolEntry.name] as Control }
        : {}),
      ...(opts.policyEndpoint !== undefined ? { policyEndpoint: opts.policyEndpoint } : {}),
      now: opts.clock,
      runnerVersion
    });
    const resolverDecision = resolverResponse.decision;

    // PDA handling
    let handlerAccepted = true;
    let finalDecision = preHookForcedPrompt ? "Prompt" as const : resolverDecision;
    let finalReason = preHookForcedPrompt ? "hook-forced-prompt" : resolverResponse.reason;
    let pdaSignerKid: string | undefined;

    if (pdaJws !== null && pdaJws !== undefined) {
      // §10.3.2 L-23: when the deployment has no PDA verify configuration but
      // a PDA-bearing request arrives, that's a server-state issue, NOT a
      // client error — 503, not 400.
      if (!opts.resolvePdaVerifyKey) {
        return reply.code(503).send({
          error: "pda-verify-unavailable",
          reason: "pda-verify-unavailable"
        });
      }

      try {
        const verified = await verifyPda({
          pdaJws,
          resolveVerifyKey: opts.resolvePdaVerifyKey,
          ...(opts.isPdaKidRevoked !== undefined ? { isRevoked: opts.isPdaKidRevoked } : {}),
          now: opts.clock,
          // L-24 conformance fixtures carry a `tool`/`capability`/`control`/
          // `decided_at` payload shape that predates the current canonical-
          // decision schema. Signature is the trust boundary; schema is
          // convenience. Skip strict validation here so both shapes round-
          // trip without rejection.
          skipPayloadSchema: true
        });
        pdaSignerKid = verified.decision.handler_kid;

        // Forgery resistance: the PDA's embedded decision MUST be consistent
        // with what the resolver concluded. For Prompt the handler picks
        // allow/deny freely; for other resolver outputs the PDA can't override.
        const expected = resolverImpliesPdaDecision(resolverDecision);
        if (expected !== "either" && verified.decision.decision !== expected) {
          await compensatePendingSideEffect(
            bracketSession,
            sideEffectIndex,
            opts.persister,
            opts.markers,
            opts.clock,
            sessionId
          );
          return reply.code(403).send({
            error: "pda-decision-mismatch",
            detail: `resolver decision ${resolverDecision} implies pda.decision=${expected}, got ${verified.decision.decision}`
          });
        }

        // When the resolver said Prompt and the PDA said deny, the endpoint
        // still reports decision=Prompt (forgery resistance: the resolver
        // output is the decision field). The PDA's deny surfaces via the
        // audit row (below).
      } catch (err) {
        if (err instanceof PdaVerifyFailed) {
          // Per §10.3.2: PDA crypto failure → coerce to Deny, handler_accepted=false,
          // audit the attempt.
          if (err.reason === "jws-malformed" || err.reason === "header-malformed" || err.reason === "payload-malformed") {
            await compensatePendingSideEffect(
              bracketSession,
              sideEffectIndex,
              opts.persister,
              opts.markers,
              opts.clock,
              sessionId
            );
            return reply.code(400).send({ error: "pda-malformed", detail: err.reason });
          }
          handlerAccepted = false;
          finalDecision = "Deny";
          finalReason = "pda-verify-failed";
        } else {
          throw err;
        }
      }
    }

    // Append audit row (§10.5 hash chain) in the exact shape audit-records-
    // response.schema.json requires. No extra fields — additionalProperties:
    // false on the record item. Reading MUST NOT write meta-records; this
    // endpoint IS the write path.
    const recordId = auditRecordId();
    const recordedAt = opts.clock().toISOString();
    const written = opts.chain.append({
      id: recordId,
      timestamp: recordedAt,
      session_id: sessionId,
      subject_id: "none", // M1: no subject inference yet (§10.7 is M3)
      tool: toolEntry.name,
      args_digest: argsDigest,
      capability: resolverResponse.resolved_capability,
      control: resolverResponse.resolved_control,
      handler: "Interactive", // M1: handler role is Agent Card config; hardcode until T-?? lands
      decision: finalDecision,
      reason: finalReason,
      signer_key_id: pdaSignerKid ?? ""
    });

    // §10.5.1 — degraded-buffering / unreachable-halt: persist the just-
    // appended row to the fsync-backed local queue. In healthy this is a
    // no-op. Awaited so a buffer-write failure surfaces to the caller
    // (can't silently drop a record when the sink is known-degraded).
    if (opts.sink) await opts.sink.recordAuditRow(written);

    // §12.2 L-31 — TOOL_INVOKE_DONE + transition pending → committed with
    // cached decision fields inline so the next idempotent submission can
    // short-circuit. The committed-phase fsync fires COMMITTED_WRITE_DONE.
    if (bracketWired && bracketSession && sideEffectIndex >= 0 && bracketIdempotencyKey !== undefined) {
      opts.markers!.toolInvokeDone(sessionId, sideEffectIndex, "committed");
      const workflow = bracketSession.workflow as {
        side_effects: CachedSideEffect[];
        [k: string]: unknown;
      };
      const se = workflow.side_effects[sideEffectIndex];
      if (se) {
        se.phase = "committed";
        se.last_phase_transition_at = opts.clock().toISOString();
        // Embed result_digest as the audit this_hash (a stable digest of the
        // decision outcome) so /state's result_digest shows something
        // meaningful for decision side_effects even before real tool
        // invocation wires in M3.
        se.result_digest = `sha256:${written.this_hash}`;
        // Cache the full response body inline for future idempotency hits.
        se._audit_record_id = recordId;
        se._audit_this_hash = written.this_hash;
        se._decision = finalDecision;
        se._resolved_capability = resolverResponse.resolved_capability;
        se._resolved_control = resolverResponse.resolved_control;
        se._reason = finalReason;
        se._handler_accepted = handlerAccepted;
        se._recorded_at = recordedAt;
      }
      await opts.persister!.writeSession(bracketSession, {
        markerPhase: { kind: "committed", side_effect: sideEffectIndex }
      });
    }

    // §13.1 budget tracking — fire after the committed-phase bracket-
    // persist write so /budget/projection advances in lockstep with the
    // session's turn count. Without real LLM dispatch yet (M3 scope
    // stops short of tool invocation), the per-turn cost is a stable
    // constant — validators observe a reliable delta per decision.
    // When the dispatcher lands, replace with API-reported token counts.
    //
    // §13.2 actual-over-budget check (HR-03 / SV-BUD-02..07). AFTER
    // recordTurn advances cumulative_tokens_consumed, compare against
    // maxTokensPerRun. When the *just-committed* turn pushed the session
    // past its hard cap, terminate the session with
    // SessionEnd{stop_reason:"BudgetExhausted"} and revoke the bearer.
    // The current turn's 201 response still fires (the turn completed
    // before the budget tripped); subsequent requests from the same
    // bearer fail at auth because the session record is gone.
    if (opts.budgetTracker) {
      // Finding P / SV-BUD-04: populate cache-accounting fields at
      // turn-commit even in M3 (pre-dispatcher). Without a real LLM
      // call path, cached counts are zero — but the fields MUST be
      // present in the TurnRecord so /budget/projection surfaces
      // deterministic cache_accounting totals (§13.3) instead of
      // leaving the validator's probe reading undefined.
      opts.budgetTracker.recordTurn(sessionId, {
        actual_total_tokens: opts.budgetPerTurnEstimate ?? 512,
        prompt_tokens_cached: 0,
        completion_tokens_cached: 0
      });
      const snapshot = opts.budgetTracker.getProjection(sessionId);
      if (
        snapshot !== undefined &&
        snapshot.cumulative_tokens_consumed >= snapshot.max_tokens_per_run
      ) {
        terminateForBudgetExhausted(
          sessionId,
          opts.emitter,
          opts.sessionStore,
          opts.budgetTracker
        );
      }
    }

    // §14.1 PermissionDecision — emit AFTER the commit write completes so
    // the event lands once per decision (not once per retry) and always
    // reflects the final recorded outcome. The prompt_id is synthesized
    // from the aud_ audit row id so clients can correlate back to the
    // chain; decision is mapped to the §14.1.1 allow/deny enum.
    if (opts.emitter) {
      const decisionAllowOrDeny = finalDecision === "AutoAllow" ? "allow" : "deny";
      opts.emitter.emit({
        session_id: sessionId,
        type: "PermissionDecision",
        payload: {
          // §14.1.1 pattern: prm_[A-Za-z0-9]{8,}. aud_<12hex> satisfies.
          prompt_id: `prm_${recordId.slice("aud_".length)}`,
          decision: decisionAllowOrDeny,
          scope: "once",
          signer_kid: pdaSignerKid ?? "runtime-resolver",
          reason: finalReason
        }
      });

      // §14.1 PreToolUseOutcome — SV-HOOK-07 ordering spec:
      // PermissionDecision → PreToolUseOutcome → ToolResult →
      // PostToolUseOutcome. Emitted once per decision when the hook ran;
      // payload carries the allow / replace_args outcome plus the pre-
      // and post-substitution digests so validators can verify the
      // resolver re-invoked against the fingerprinted args.
      if (pendingPreToolUseOutcome) {
        opts.emitter.emit({
          session_id: sessionId,
          type: "PreToolUseOutcome",
          payload: {
            tool_call_id: toolCallId,
            tool_name: toolEntry.name,
            outcome: pendingPreToolUseOutcome.outcome,
            ...(pendingPreToolUseOutcome.reason !== undefined
              ? { reason: pendingPreToolUseOutcome.reason }
              : {}),
            args_digest_before: pendingPreToolUseOutcome.args_digest_before,
            ...(pendingPreToolUseOutcome.args_digest_after !== undefined
              ? { args_digest_after: pendingPreToolUseOutcome.args_digest_after }
              : {})
          }
        });
      }
    }

    // §15 PostToolUse hook + §14.1 PostToolUseOutcome — advisory at the
    // response-body level (exit codes don't flip decision back to Deny)
    // but emits a §14.1 PostToolUseOutcome StreamEvent with the hook's
    // view of the tool result. Ordering (SV-HOOK-07):
    //   PermissionDecision → PreToolUseOutcome → [ToolResult] →
    //   PostToolUseOutcome. Fires ONLY when the emitter is wired; raw
    //   hook output still reaches the hook's own stderr/stdout either way.
    //
    // §15.3 stdout.replace_result: canonicalize the substituted result
    // (JCS-RFC-8785), re-fingerprint, and carry both before/after digests
    // in the event payload — Finding M / SV-HOOK-06.
    if (opts.hookConfig?.postToolUseCommand && opts.hookConfig.postToolUseCommand.length > 0) {
      const turnId = opts.hookConfig.turnIdFn?.() ?? `turn_${randomBytes(6).toString("hex")}`;
      // In M3 there's no real tool dispatcher yet — the Runner uses the
      // audit-row this_hash as a synthetic output_digest so the
      // before/after contract is still well-defined. When the M4
      // dispatcher lands, substitute the real tool-result digest here.
      const outputDigestBefore = `sha256:${written.this_hash}`;
      let trackedPostHookPid: number | null = null;
      const hookOutcome: HookOutcome = await runHook({
        command: opts.hookConfig.postToolUseCommand,
        stdin: {
          hook: "PostToolUse",
          session_id: sessionId,
          turn_id: turnId,
          tool: { name: toolEntry.name, risk_class: toolEntry.risk_class, args_digest: argsDigest },
          capability: sessionRecord.activeMode,
          handler: "Interactive",
          result: { ok: handlerAccepted, output_digest: outputDigestBefore }
        },
        ...(opts.hookReentrancy
          ? {
              onSpawn: (pid: number): void => {
                trackedPostHookPid = pid;
                opts.hookReentrancy!.begin(sessionId, pid);
              },
              onExit: (): void => {
                if (trackedPostHookPid !== null) {
                  opts.hookReentrancy!.end(sessionId, trackedPostHookPid);
                  trackedPostHookPid = null;
                }
              }
            }
          : {})
      });

      if (opts.emitter) {
        const replaceResult = hookOutcome.stdout?.replace_result;
        if (replaceResult !== undefined) {
          const outputDigestAfter =
            `sha256:${createHash("sha256").update(jcsBytes(replaceResult)).digest("hex")}`;
          opts.emitter.emit({
            session_id: sessionId,
            type: "PostToolUseOutcome",
            payload: {
              tool_call_id: toolCallId,
              tool_name: toolEntry.name,
              outcome: "replace_result",
              ...(hookOutcome.stdout?.reason !== undefined
                ? { reason: hookOutcome.stdout.reason }
                : {}),
              output_digest_before: outputDigestBefore,
              output_digest_after: outputDigestAfter
            }
          });
        } else {
          // `pass` is the §14.1 enum value for "hook acknowledged
          // without substitution" — covers clean exit 0, advisory
          // non-zero exits, and timeouts. The failure reason (when
          // present) surfaces via payload.reason so the validator can
          // still audit hook health without a separate error event.
          opts.emitter.emit({
            session_id: sessionId,
            type: "PostToolUseOutcome",
            payload: {
              tool_call_id: toolCallId,
              tool_name: toolEntry.name,
              outcome: "pass",
              ...(hookOutcome.stdout?.reason !== undefined
                ? { reason: hookOutcome.stdout.reason }
                : hookOutcome.reason !== undefined
                  ? { reason: hookOutcome.reason }
                  : {}),
              output_digest_before: outputDigestBefore
            }
          });
        }
      }
    }

    return reply.code(201).send({
      decision: finalDecision,
      resolved_capability: resolverResponse.resolved_capability,
      resolved_control: resolverResponse.resolved_control,
      reason: finalReason,
      audit_record_id: recordId,
      audit_this_hash: written.this_hash,
      handler_accepted: handlerAccepted,
      runner_version: runnerVersion,
      recorded_at: recordedAt,
      ...(bracketIdempotencyKey !== undefined ? { idempotency_key: bracketIdempotencyKey } : {})
    });
  });
};

/**
 * Roll a pending side_effect forward to `compensated` when dispatch fails
 * with a classified error (pda-malformed, pda-decision-mismatch). Best-
 * effort: a failure to persist the compensation leaves the pending row on
 * disk; the caller still returns the 4xx to the client — the resume
 * algorithm's §12.5 step 4 will mark it compensated with a
 * ResumeCompensationGap note on next boot.
 */
async function compensatePendingSideEffect(
  bracketSession: PersistedSession | null,
  sideEffectIndex: number,
  persister: SessionPersister | undefined,
  markers: MarkerEmitter | undefined,
  clock: Clock,
  sessionId: string
): Promise<void> {
  if (!bracketSession || !persister || sideEffectIndex < 0) return;
  try {
    const workflow = bracketSession.workflow as { side_effects: PersistedSideEffect[] };
    const se = workflow.side_effects[sideEffectIndex];
    if (!se) return;
    se.phase = "compensated";
    se.last_phase_transition_at = clock().toISOString();
    await persister.writeSession(bracketSession);
    markers?.toolInvokeDone(sessionId, sideEffectIndex, "compensated");
  } catch {
    // Swallow — the 4xx return is the primary signal to the client.
  }
}

/**
 * §13.2 BudgetExhausted termination helper (HR-02 + HR-03 / SV-BUD-02..07).
 *
 * Shared by the pre-call projection-over check (HR-02) and the post-commit
 * actual-over check (HR-03). Emits SessionEnd{stop_reason:"BudgetExhausted"}
 * on the emitter, revokes the session bearer via SessionStore.revoke() so
 * subsequent requests fail at auth, and drops the session from the
 * BudgetTracker to free memory. Idempotent — safe to call twice (the
 * second pass is a no-op).
 *
 * The emitter + store are optional: callers may wire the helper against
 * a minimum-viable plugin composition that omits one or the other. When
 * the emitter is missing, termination still removes state but the
 * validator loses the SessionEnd observable; when the store lacks
 * revoke() (SessionStore interface variant), we silently skip.
 */
function terminateForBudgetExhausted(
  sessionId: string,
  emitter: StreamEventEmitter | undefined,
  sessionStore: SessionStore,
  budgetTracker: BudgetTracker
): void {
  if (emitter) {
    emitter.emit({
      session_id: sessionId,
      type: "SessionEnd",
      payload: { stop_reason: "BudgetExhausted" }
    });
  }
  const store = sessionStore as unknown as { revoke?: (id: string) => void };
  if (typeof store.revoke === "function") store.revoke(sessionId);
  budgetTracker.remove(sessionId);
}
