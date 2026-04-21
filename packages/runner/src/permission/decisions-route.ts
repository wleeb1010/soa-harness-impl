import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { AuditChain } from "../audit/index.js";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { ToolRegistry } from "../registry/index.js";
import type { Control } from "../registry/types.js";
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

export const permissionsDecisionsPlugin: FastifyPluginAsync<
  PermissionsDecisionsRouteOptions
> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new BearerLimiter(opts.requestsPerMinute ?? 30, opts.clock);
  const validateBody = schemaRegistry["permission-decision-request"];

  app.post("/permissions/decisions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

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
    const argsDigest = body.args_digest as string;
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
    let finalDecision = resolverDecision;
    let finalReason = resolverResponse.reason;
    let pdaSignerKid: string | undefined;

    if (pdaJws !== null && pdaJws !== undefined) {
      // Verify PDA crypto first. Malformed → 400.
      if (!opts.resolvePdaVerifyKey) {
        return reply.code(400).send({
          error: "pda-verify-not-configured",
          detail: "Runner was not started with resolvePdaVerifyKey; cannot verify a PDA"
        });
      }

      try {
        const verified = await verifyPda({
          pdaJws,
          resolveVerifyKey: opts.resolvePdaVerifyKey,
          ...(opts.isPdaKidRevoked !== undefined ? { isRevoked: opts.isPdaKidRevoked } : {}),
          now: opts.clock
        });
        pdaSignerKid = verified.decision.handler_kid;

        // Forgery resistance: the PDA's embedded decision MUST be consistent
        // with what the resolver concluded. For Prompt the handler picks
        // allow/deny freely; for other resolver outputs the PDA can't override.
        const expected = resolverImpliesPdaDecision(resolverDecision);
        if (expected !== "either" && verified.decision.decision !== expected) {
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

    // Append audit row (§10.5 hash chain). Reading MUST NOT write meta-records;
    // this endpoint IS the write path.
    const recordId = auditRecordId();
    const recordedAt = opts.clock().toISOString();
    const written = opts.chain.append({
      audit_record_id: recordId,
      kind: "permission-decision",
      tool: toolEntry.name,
      session_id: sessionId,
      args_digest: argsDigest,
      decision: finalDecision,
      resolved_control: resolverResponse.resolved_control,
      resolved_capability: resolverResponse.resolved_capability,
      reason: finalReason,
      handler_accepted: handlerAccepted,
      ...(pdaSignerKid !== undefined ? { pda_signer_kid: pdaSignerKid } : {}),
      recorded_at: recordedAt
    });

    return reply.code(201).send({
      decision: finalDecision,
      resolved_capability: resolverResponse.resolved_capability,
      resolved_control: resolverResponse.resolved_control,
      reason: finalReason,
      audit_record_id: recordId,
      audit_this_hash: written.this_hash,
      handler_accepted: handlerAccepted,
      runner_version: runnerVersion,
      recorded_at: recordedAt
    });
  });
};
