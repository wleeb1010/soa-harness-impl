/**
 * §12.5.4 Audit-Sink Event Channel — `GET /audit/sink-events`.
 *
 * Minimum-viable observability channel for AuditSink* state-transition
 * events (§10.5.1). Full StreamEvent transport (§14) is M3 scope; this
 * polling-friendly endpoint lets M2 conformance validators fire
 * SV-PERM-19 + SV-AUDIT-SINK-EVENTS-01 end-to-end.
 *
 * Same pagination protocol as /audit/records (§10.5.3):
 *   after=<event_id>&limit=<n> → { events, next_after, has_more, ... }
 *
 * Same auth + rate-limit rules as /audit/tail + /audit/records:
 *   audit:read scope (any session bearer), 60 rpm per bearer.
 *
 * Byte-identity contract (L-28 F-01 rule applies here too): two successive
 * reads of a quiescent channel produce byte-identical bodies EXCEPT for
 * `generated_at`. Implementation fixes key order at build time.
 *
 * Response body validated against the pinned
 * schemas/audit-sink-events-response.schema.json before reply — a drift
 * surfaces as 500 response-schema-violation with Ajv errors.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/index.js";
import type { AuditSink, AuditSinkEvent } from "./sink.js";

export interface AuditSinkEventsRouteOptions {
  sink: AuditSink;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /** §12.5.4 default 60 rpm per bearer. */
  requestsPerMinute?: number;
  defaultLimit?: number;
  maxLimit?: number;
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
  return match ? match[1] ?? null : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function bearerAuthorizedForAuditRead(store: SessionStore, bearer: string): boolean {
  const maybe = (store as unknown as { anySession?: (b: string) => boolean }).anySession;
  return typeof maybe === "function" ? maybe.call(store, bearer) : false;
}

export const auditSinkEventsPlugin: FastifyPluginAsync<AuditSinkEventsRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 1000;
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);
  const responseValidator = schemaRegistry["audit-sink-events-response"];

  app.get("/audit/sink-events", async (request, reply) => {
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

    const q = request.query as Record<string, unknown>;
    const after = typeof q["after"] === "string" ? (q["after"] as string) : undefined;
    const limitParam =
      typeof q["limit"] === "string" ? Number.parseInt(q["limit"] as string, 10) : undefined;
    if (limitParam !== undefined && (!Number.isFinite(limitParam) || limitParam < 1)) {
      return reply.code(400).send({ error: "malformed-limit" });
    }
    const limit = Math.min(Math.max(limitParam ?? defaultLimit, 1), maxLimit);

    const all = opts.sink.snapshotEvents();
    let startIdx = 0;
    if (after !== undefined) {
      const idx = all.findIndex((e) => e.event_id === after);
      if (idx < 0) return reply.code(404).send({ error: "unknown-after-id" });
      startIdx = idx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit) as AuditSinkEvent[];
    const hasMore = startIdx + limit < all.length;

    // Body assembled in fixed key order so two successive reads of a
    // quiescent channel produce byte-identical bodies modulo `generated_at`.
    const body: Record<string, unknown> = {
      events: page,
      has_more: hasMore,
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (page.length > 0) {
      const last = page[page.length - 1]!;
      body["next_after"] = last.event_id;
    }

    // Validate outgoing body against the pinned schema — drift surfaces as 500.
    if (!responseValidator(body)) {
      return reply.code(500).send({
        error: "response-schema-violation",
        detail: JSON.stringify(responseValidator.errors ?? [])
      });
    }

    return reply.code(200).send(body);
  });
};
