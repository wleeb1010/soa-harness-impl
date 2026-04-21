import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import { CAPABILITY_PERMITS, type Capability } from "./types.js";
import { InMemorySessionStore } from "./session-store.js";

export interface SessionsRouteOptions {
  sessionStore: InMemorySessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  /** Agent Card permissions.activeMode — upper bound for granted_activeMode. */
  cardActiveMode: Capability;
  /** Fixed bootstrap bearer. Loopback listeners only per §12.6. */
  bootstrapBearer: string;
  /** Seconds. Default 3600 (1h). Clamped to [60, 86400]. */
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  runnerVersion?: string;
  requestsPerMinute?: number;
}

const WINDOW_MS = 60_000;
const TTL_MIN = 60;
const TTL_MAX = 86_400;
const CAP_RANK: Record<Capability, number> = { ReadOnly: 0, WorkspaceWrite: 1, DangerFullAccess: 2 };

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? (match[1] ?? null) : null;
}

class BootstrapLimiter {
  private readonly hits: number[] = [];
  constructor(private readonly limit: number, private readonly now: Clock) {}
  consume(): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    while (this.hits.length > 0 && t - (this.hits[0] ?? t) >= WINDOW_MS) this.hits.shift();
    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0] ?? t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000)) };
    }
    this.hits.push(t);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

interface BootstrapRequest {
  requested_activeMode?: unknown;
  user_sub?: unknown;
  session_ttl_seconds?: unknown;
  /**
   * T-03: when `true`, the returned session_bearer carries the
   * `permissions:decide:<session_id>` scope in addition to the default
   * `stream:read:<sid>` + `permissions:resolve:<sid>` + `audit:read`.
   * Default false. `sessions:create` is never carried on session bearers.
   */
  request_decide_scope?: unknown;
}

export const sessionsBootstrapPlugin: FastifyPluginAsync<SessionsRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultTtl = Math.min(Math.max(opts.defaultTtlSeconds ?? 3600, TTL_MIN), TTL_MAX);
  const maxTtl = Math.min(opts.maxTtlSeconds ?? TTL_MAX, TTL_MAX);
  const limiter = new BootstrapLimiter(opts.requestsPerMinute ?? 30, opts.clock);
  const validModes = new Set(Object.keys(CAPABILITY_PERMITS) as Capability[]);

  app.post("/sessions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (bearer !== opts.bootstrapBearer) {
      return reply.code(401).send({ error: "missing-or-invalid-bootstrap-bearer" });
    }

    const rl = limiter.consume();
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const body = (request.body ?? {}) as BootstrapRequest;
    const requested = body.requested_activeMode;
    const userSub = body.user_sub;
    const ttlRaw = body.session_ttl_seconds;

    if (typeof requested !== "string" || !validModes.has(requested as Capability)) {
      return reply.code(400).send({ error: "malformed-request", detail: "requested_activeMode missing or invalid" });
    }
    if (typeof userSub !== "string" || userSub.length === 0) {
      return reply.code(400).send({ error: "malformed-request", detail: "user_sub missing" });
    }
    let ttlSeconds: number = defaultTtl;
    if (ttlRaw !== undefined) {
      if (typeof ttlRaw !== "number" || !Number.isInteger(ttlRaw) || ttlRaw < TTL_MIN || ttlRaw > TTL_MAX) {
        return reply.code(400).send({ error: "malformed-request", detail: `session_ttl_seconds must be an integer in [${TTL_MIN}, ${TTL_MAX}]` });
      }
      ttlSeconds = Math.min(ttlRaw, maxTtl);
    }

    // T-03: request_decide_scope must be boolean when present.
    const rawDecideScope = body.request_decide_scope;
    if (rawDecideScope !== undefined && typeof rawDecideScope !== "boolean") {
      return reply
        .code(400)
        .send({ error: "malformed-request", detail: "request_decide_scope must be a boolean" });
    }
    const canDecide = rawDecideScope === true;

    const requestedMode = requested as Capability;
    if (CAP_RANK[requestedMode] > CAP_RANK[opts.cardActiveMode]) {
      return reply.code(403).send({
        error: "ConfigPrecedenceViolation",
        detail: `requested_activeMode=${requestedMode} exceeds Agent Card permissions.activeMode=${opts.cardActiveMode}`
      });
    }

    const created = opts.sessionStore.create({
      activeMode: requestedMode,
      user_sub: userSub,
      ttlSeconds,
      now: opts.clock(),
      canDecide
    });

    return reply.code(201).send({
      session_id: created.session_id,
      session_bearer: created.session_bearer,
      granted_activeMode: created.record.activeMode,
      expires_at: created.record.expires_at.toISOString(),
      runner_version: runnerVersion
    });
  });
};
