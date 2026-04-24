/**
 * §16.3 + §16.4 dispatch HTTP routes.
 *
 *   POST /dispatch                — fire a dispatch per §16.3 request contract
 *   GET  /dispatch/recent         — read recent-dispatch observability per §16.4
 *
 * Auth model (both routes):
 *   - Session bearer (sessions:read:<session_id> implicitly carries dispatch
 *     rights for that session) — looked up via SessionStore.validate()
 *   - No admin override for /dispatch itself — dispatch must belong to a
 *     session; admin bearers may use /dispatch/recent with session_id param
 *
 * Rate limit: 120 rpm per bearer, same convention as other observability
 * surfaces (§13.5 /budget/projection, §14.5 /events/recent, §10.5.2 /audit/tail).
 *
 * Readiness gate: 503 with §5.4 closed-enum reason when pre-boot.
 *
 * Runners MAY omit wiring this plugin entirely (early-milestone deployments
 * that don't yet expose dispatch). Per §16.4 contract, /dispatch/recent in
 * that case returns 404 — absence is observable. `buildRunnerApp` honors
 * this by gating plugin registration on `opts.dispatch` being set.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { Dispatcher } from "./dispatcher.js";
import type { DispatchRequest } from "./types.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

export interface DispatchRouteOptions {
  dispatcher: Dispatcher;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /** Default 120 req/min per bearer per observability convention. */
  requestsPerMinute?: number;
  /**
   * Admin bearer grants cross-session /dispatch/recent access. Same
   * convention as §14.5.5 events-recent admin surface. When undefined,
   * only session bearers can read /dispatch/recent for their own session.
   */
  bootstrapBearer?: string;
  /** Per-bearer rate limit under admin:read (default 60). */
  adminRequestsPerMinute?: number;
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
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000)),
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

export const dispatchPlugin: FastifyPluginAsync<DispatchRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.1";
  const sessionLimiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const adminLimiter = new PerBearerLimiter(opts.adminRequestsPerMinute ?? 60, opts.clock);
  const requestValidator = schemaRegistry["llm-dispatch-request"];
  const recentResponseValidator = schemaRegistry["dispatch-recent-response"];

  // ────────────────────────────────────────────────────────────────────────
  // POST /dispatch — fire a single dispatcher call
  // ────────────────────────────────────────────────────────────────────────
  app.post("/dispatch", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    const rl = sessionLimiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const body = request.body as unknown;
    if (body === null || typeof body !== "object") {
      return reply.code(400).send({ error: "malformed-body" });
    }

    // Request schema validation happens inside Dispatcher.dispatch() too, but
    // we do it here first to get the 4xx status right (dispatcher converts
    // schema failures into a 200 DispatcherError response — fine for the
    // contract, but HTTP callers expect 400 on obviously-malformed bodies).
    if (!requestValidator(body)) {
      return reply.code(400).send({
        error: "dispatch-request-invalid",
        details: requestValidator.errors ?? [],
      });
    }

    const req = body as DispatchRequest;

    // Session bearer scope — the session_id in the dispatch request must
    // match a session this bearer owns.
    if (!SESSION_ID_RE.test(req.session_id)) {
      return reply.code(400).send({ error: "malformed-session-id" });
    }
    if (!opts.sessionStore.exists(req.session_id)) {
      return reply.code(404).send({ error: "unknown-session" });
    }
    if (!opts.sessionStore.validate(req.session_id, bearer)) {
      return reply.code(403).send({ error: "session-bearer-mismatch" });
    }

    const dispatchResponse = await opts.dispatcher.dispatch(req);
    // All successful + error-classified responses come back as valid
    // DispatchResponse — dispatcher preserves HTTP 200 semantics; the
    // stop_reason + dispatcher_error_code surface failure detail.
    return reply.code(200).send(dispatchResponse);
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /dispatch/recent — read recent-dispatch observability
  // ────────────────────────────────────────────────────────────────────────
  app.get("/dispatch/recent", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    const isAdmin = opts.bootstrapBearer !== undefined && bearer === opts.bootstrapBearer;
    const rl = (isAdmin ? adminLimiter : sessionLimiter).consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const q = request.query as Record<string, unknown>;
    const sessionIdParam = typeof q["session_id"] === "string" ? (q["session_id"] as string) : undefined;
    const limitParam =
      typeof q["limit"] === "string" ? Number.parseInt(q["limit"] as string, 10) : undefined;

    if (!sessionIdParam || !SESSION_ID_RE.test(sessionIdParam)) {
      return reply.code(400).send({ error: "malformed-session-id" });
    }
    if (!isAdmin) {
      if (!opts.sessionStore.exists(sessionIdParam)) {
        return reply.code(404).send({ error: "unknown-session" });
      }
      if (!opts.sessionStore.validate(sessionIdParam, bearer)) {
        return reply.code(403).send({ error: "session-bearer-mismatch" });
      }
    }

    if (limitParam !== undefined && (!Number.isFinite(limitParam) || limitParam < 1 || limitParam > 500)) {
      return reply.code(400).send({ error: "malformed-limit" });
    }
    const limit = limitParam ?? 50;

    const body = opts.dispatcher.recent_response(sessionIdParam, limit);
    // Overwrite runner_version so the plugin's opt wins over any default
    // in the dispatcher's own configuration.
    body.runner_version = runnerVersion;

    if (!recentResponseValidator(body)) {
      return reply.code(500).send({
        error: "dispatch-recent-response-schema-drift",
        details: recentResponseValidator.errors ?? [],
      });
    }
    return reply.code(200).send(body);
  });
};
