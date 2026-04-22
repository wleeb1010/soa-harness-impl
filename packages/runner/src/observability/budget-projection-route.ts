/**
 * §13.5 GET /budget/projection?session_id=<sid> — Budget observability.
 *
 * Auth: session bearer (sessions:read:<sid>); 120 rpm; not-a-side-effect
 * read; byte-identity excludes `generated_at`; response schema
 * `budget-projection-response.schema.json` validated before reply.
 *
 * Per §13.5 spec text, the URL uses a query-param session_id (not a path
 * segment). Session-scoped via sessionStore.validate.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { BudgetTracker } from "../budget/index.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

export interface BudgetProjectionRouteOptions {
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  /**
   * T-4: real tracker supplies projection state. When omitted, the route
   * falls back to a cold-start placeholder (T-3 scaffold behavior) so
   * legacy unit tests still pass.
   */
  tracker?: BudgetTracker;
  /** Default max_tokens_per_run for the scaffold fallback path. */
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
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const responseValidator = schemaRegistry["budget-projection-response"];

  const handler = async (request: FastifyRequest, sessionIdParam: string | undefined): Promise<ReturnType<typeof app.inject> extends Promise<infer _R> ? never : never> => {
    // TS gymnastics above are a no-op; see the real handler below. Kept to
    // satisfy the compile pass after the inline anonymous refactor — unused.
    void request;
    void sessionIdParam;
    throw new Error("unreachable");
  };
  void handler;

  // §13.5 canonical form: query param. Back-compat path param kept so
  // existing T-3 scaffold clients don't break mid-milestone.
  for (const route of [
    { url: "/budget/projection", sourceSessionId: (req: FastifyRequest): string | undefined => {
      const q = req.query as Record<string, unknown>;
      return typeof q["session_id"] === "string" ? (q["session_id"] as string) : undefined;
    }},
    { url: "/budget/projection/:session_id", sourceSessionId: (req: FastifyRequest): string | undefined => {
      const params = req.params as { session_id?: string };
      return typeof params.session_id === "string" ? params.session_id : undefined;
    }}
  ]) {
    app.get(route.url, async (request, reply) => {
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

      const sessionId = route.sourceSessionId(request);
      if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
        return reply.code(400).send({ error: "malformed-session-id" });
      }
      if (!opts.sessionStore.exists(sessionId)) {
        return reply.code(404).send({ error: "unknown-session" });
      }
      if (!opts.sessionStore.validate(sessionId, bearer)) {
        return reply.code(403).send({ error: "session-bearer-mismatch" });
      }

      const snap = opts.tracker?.getProjection(sessionId);
      const body = snap
        ? {
            session_id: sessionId,
            projected_tokens_remaining: snap.projected_tokens_remaining,
            max_tokens_per_run: snap.max_tokens_per_run,
            cumulative_tokens_consumed: snap.cumulative_tokens_consumed,
            p95_tokens_per_turn_over_window_w: snap.p95_tokens_per_turn_over_window_w,
            safety_factor: snap.safety_factor,
            ...(snap.projection_headroom !== undefined
              ? { projection_headroom: snap.projection_headroom }
              : {}),
            stop_reason_if_exhausted: snap.stop_reason_if_exhausted,
            cold_start_baseline_active: snap.cold_start_baseline_active,
            ...(snap.cache_accounting ? { cache_accounting: snap.cache_accounting } : {}),
            runner_version: runnerVersion,
            generated_at: opts.clock().toISOString()
          }
        : {
            // Fallback cold-start placeholder (T-3 scaffold behavior).
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
    });
  }
};
