/**
 * §8.6 GET /memory/state/:session_id — Memory observability.
 *
 * Auth: session bearer for THIS session (sessions:read scope default-
 * granted by §12.6 bootstrap). The plan's "memory.read scope" is a §8.5
 * refinement of that default grant.
 * Rate limit: 120 rpm per bearer (matches /sessions/:id/state).
 *
 * Response: memory-state-response.schema.json — validated before reply.
 * Byte-identity excludes `generated_at`; reads MUST NOT trigger
 * consolidation or advance aging clocks (not-a-side-effect).
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { InMemoryMemoryStateStore } from "./state-store.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

export interface MemoryStateRouteOptions {
  memoryStore: InMemoryMemoryStateStore;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
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

export const memoryStatePlugin: FastifyPluginAsync<MemoryStateRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const responseValidator = schemaRegistry["memory-state-response"];

  app.get<{ Params: { session_id: string } }>(
    "/memory/state/:session_id",
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

      const state = opts.memoryStore.get(sessionId);
      if (!state) {
        // Session exists but Memory state wasn't initialized — treat as
        // 404 rather than silently returning a default zero-state body,
        // so operators see the wiring gap.
        return reply.code(404).send({ error: "memory-state-not-initialized" });
      }

      const body = {
        session_id: state.session_id,
        sharing_policy: state.sharing_policy,
        in_context_notes: state.in_context_notes,
        available_notes_count: state.available_notes_count,
        consolidation: state.consolidation,
        aging: state.aging,
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
