/**
 * §14.5.2 GET /observability/otel-spans/recent — polling OTel observability.
 *
 * Query params:
 *   session_id=<sid>       required — scope to a single session
 *   after=<span_id>        optional — pagination anchor
 *   limit=<n>              optional — 1..1000, default 100
 *
 * Auth: sessions:read:<sid> scope (same pattern as /events/recent).
 * Rate limit: 120 rpm per bearer.
 * Readiness gate: 503 with §5.4 closed-enum reason when pre-boot.
 *
 * Body: otel-spans-recent-response.schema.json (pinned). Drift → 500.
 * NOT-A-SIDE-EFFECT on reads; defensive copies all the way through.
 *
 * Production guard note: §14.5.2 carries OTel span attributes that
 * MAY include PII or sensitive tool args. The endpoint SHOULD run
 * behind TLS 1.3 + loopback-only in a production-equivalent
 * deployment; that guard is enforced at bin start-up (TLS gating)
 * rather than per-request.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { OtelSpanStore, OtelSpanRecord } from "./otel-span-store.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

export interface OtelSpansRouteOptions {
  store: OtelSpanStore;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  defaultLimit?: number;
  maxLimit?: number;
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

export const otelSpansRecentPlugin: FastifyPluginAsync<OtelSpansRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 1000;
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const responseValidator = schemaRegistry["otel-spans-recent-response"];

  app.get("/observability/otel-spans/recent", async (request, reply) => {
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

    const q = request.query as Record<string, unknown>;
    const sessionId = typeof q["session_id"] === "string" ? q["session_id"] : undefined;
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
      return reply.code(400).send({ error: "malformed-session-id" });
    }
    const after = typeof q["after"] === "string" ? q["after"] : undefined;
    const limitParam =
      typeof q["limit"] === "string" ? Number.parseInt(q["limit"], 10) : undefined;
    if (limitParam !== undefined && (!Number.isFinite(limitParam) || limitParam < 1)) {
      return reply.code(400).send({ error: "malformed-limit" });
    }
    const limit = Math.min(Math.max(limitParam ?? defaultLimit, 1), maxLimit);

    if (!opts.sessionStore.exists(sessionId)) {
      return reply.code(404).send({ error: "unknown-session" });
    }
    if (!opts.sessionStore.validate(sessionId, bearer)) {
      return reply.code(403).send({ error: "session-bearer-mismatch" });
    }

    const all = opts.store.snapshot(sessionId) as OtelSpanRecord[];
    let startIdx = 0;
    if (after !== undefined) {
      const idx = all.findIndex((s) => s.span_id === after);
      if (idx < 0) return reply.code(404).send({ error: "unknown-after-id" });
      startIdx = idx + 1;
    }
    const page = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;

    const body: Record<string, unknown> = {
      spans: page,
      has_more: hasMore,
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (page.length > 0) {
      const last = page[page.length - 1]!;
      body["next_after"] = last.span_id;
    }

    if (!responseValidator(body)) {
      return reply.code(500).send({
        error: "response-schema-violation",
        detail: JSON.stringify(responseValidator.errors ?? [])
      });
    }

    return reply.code(200).send(body);
  });
};
