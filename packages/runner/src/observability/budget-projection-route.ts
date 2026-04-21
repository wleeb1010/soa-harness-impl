/**
 * §13.5 GET /budget/projection — scaffold stub (M3-T3).
 *
 * Ships a schema-conformant placeholder body so validators can pre-wire
 * their handlers in Week 1. Full projection behavior (§13.1 p95-over-W
 * + 1.15 safety factor + cold-start baseline) lands with M3-T4 in Week 2.
 *
 * Response is fixed-shape for byte-identity post-turn-freeze; current
 * impl hard-codes a quiescent ReadOnly-idle session projection.
 *
 * Auth + rate-limit mirror /audit/records: `audit:read` scope on any
 * session bearer, 60 rpm. L-28 F-01 byte-identity rule applies —
 * `generated_at` excluded from byte-identity comparison.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

export interface BudgetProjectionRouteOptions {
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  /**
   * Default max_tokens_per_run embedded in the stub response. Real budget
   * accounting lands with T-4; this keeps the placeholder stable for
   * schema-pre-wire tests.
   */
  defaultMaxTokensPerRun?: number;
}

class PerBearerLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: Clock) {}

  consume(bearerHash: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    const fresh = (this.windows.get(bearerHash) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      this.windows.set(bearerHash, fresh);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000))
      };
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
  return match ? (match[1] ?? null) : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const budgetProjectionPlugin: FastifyPluginAsync<BudgetProjectionRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultMax = opts.defaultMaxTokensPerRun ?? 100_000;
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);
  const responseValidator = schemaRegistry["budget-projection-response"];

  app.get<{ Params: { session_id: string } }>(
    "/budget/projection/:session_id",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");

      const notReady = opts.readiness.check();
      if (notReady !== null) {
        return reply.code(503).send({ status: "not-ready", reason: notReady });
      }

      const bearer = extractBearer(request);
      if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

      const rl = limiter.consume(sha256Hex(bearer));
      if (!rl.allowed) {
        reply.header("Retry-After", String(rl.retryAfterSeconds));
        return reply.code(429).send({ error: "rate-limit-exceeded" });
      }

      const { session_id: sessionId } = request.params;
      if (!SESSION_ID_RE.test(sessionId)) {
        return reply.code(400).send({ error: "malformed-session-id" });
      }
      if (!opts.sessionStore.exists(sessionId)) {
        return reply.code(404).send({ error: "unknown-session" });
      }
      if (!opts.sessionStore.validate(sessionId, bearer)) {
        return reply.code(403).send({ error: "session-bearer-mismatch" });
      }

      // T-3 scaffold: cold-start quiescent session. T-4 replaces this with
      // real p95-over-W + cumulative-consumed accounting.
      const body = {
        session_id: sessionId,
        projected_tokens_remaining: defaultMax,
        max_tokens_per_run: defaultMax,
        cumulative_tokens_consumed: 0,
        p95_tokens_per_turn_over_window_w: 0,
        safety_factor: 1.15 as const,
        stop_reason_if_exhausted: "BudgetExhausted" as const,
        cold_start_baseline_active: true,
        runner_version: runnerVersion,
        generated_at: opts.clock().toISOString()
      };

      if (!responseValidator(body)) {
        return reply.code(500).send({
          error: "response-schema-violation",
          detail: JSON.stringify(responseValidator.errors ?? [])
        });
      }

      return reply.code(200).send(body);
    }
  );
};
