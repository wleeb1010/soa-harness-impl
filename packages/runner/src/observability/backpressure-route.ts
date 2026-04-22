/**
 * §14.5.3 GET /observability/backpressure — process-global pressure snapshot.
 *
 * Auth: admin:read scope. In M3 the bootstrap bearer carries this scope
 * implicitly (same pattern as /tools/registered admin surface); production
 * deployments layer a real admin-scope check via proxy.
 *
 * Rate limit: 60 rpm per bearer (§14.5.3).
 * Readiness gate: 503 with §5.4 closed-enum reason pre-boot.
 * NOT-A-SIDE-EFFECT: reads return defensive snapshot — no counters advance.
 *
 * Body: backpressure-status-response.schema.json (pinned). Drift → 500.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { BackpressureState } from "./backpressure-state.js";

const WINDOW_MS = 60_000;

export interface BackpressureRouteOptions {
  state: BackpressureState;
  /**
   * Used to authorize `admin:read` — in M3 we accept either the
   * bootstrap bearer (the privileged out-of-band secret set via
   * SOA_RUNNER_BOOTSTRAP_BEARER) OR any registered session bearer.
   * The latter matches the existing /audit/records admin convention
   * in `anySession(bearer)`.
   */
  sessionStore: SessionStore;
  bootstrapBearer?: string;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
}

class PerBearerLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly now: Clock
  ) {}
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

function bearerAuthorizedForAdminRead(
  store: SessionStore,
  bootstrapBearer: string | undefined,
  bearer: string
): boolean {
  if (bootstrapBearer !== undefined && bearer === bootstrapBearer) return true;
  const maybe = (store as unknown as { anySession?: (b: string) => boolean }).anySession;
  return typeof maybe === "function" ? maybe.call(store, bearer) : false;
}

export const backpressureStatusPlugin: FastifyPluginAsync<BackpressureRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);
  const responseValidator = schemaRegistry["backpressure-status-response"];

  app.get("/observability/backpressure", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    if (!bearerAuthorizedForAdminRead(opts.sessionStore, opts.bootstrapBearer, bearer)) {
      return reply.code(403).send({ error: "bearer-lacks-admin-read-scope" });
    }

    const rl = limiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const snap = opts.state.snapshot();
    const body = {
      ...snap,
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
};
