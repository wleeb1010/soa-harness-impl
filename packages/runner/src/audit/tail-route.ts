import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/index.js";
import { AuditChain } from "./chain.js";

export interface AuditTailRouteOptions {
  chain: AuditChain;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /** Default 120 req/min per bearer per §10.5.2. */
  requestsPerMinute?: number;
}

const WINDOW_MS = 60_000;

class PerBearerLimiter {
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

/**
 * Any valid session bearer implicitly carries `audit:read` scope per the
 * §12.6 session-bearer scope list. We validate by asking the session store
 * if the bearer matches ANY known session — no session_id is required in
 * the request.
 */
function bearerAuthorizedForAuditRead(store: SessionStore, bearer: string): boolean {
  // Extend the SessionStore protocol with a convenience for this case.
  const maybeAny = (store as unknown as { anySession?: (bearer: string) => boolean }).anySession;
  if (typeof maybeAny === "function") return maybeAny.call(store, bearer);
  // Fallback: no-op authorization when the store lacks that helper (test stubs).
  return false;
}

export const auditTailPlugin: FastifyPluginAsync<AuditTailRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);

  app.get("/audit/tail", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    if (!bearerAuthorizedForAuditRead(opts.sessionStore, bearer)) {
      return reply.code(403).send({ error: "bearer-lacks-audit-read-scope" });
    }

    const rl = limiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const count = opts.chain.recordCount();
    const last = opts.chain.lastRecordTimestamp();
    const body: Record<string, unknown> = {
      this_hash: opts.chain.tailHash(),
      record_count: count,
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (last !== undefined) body["last_record_timestamp"] = last;
    return reply.code(200).send(body);
  });
};
