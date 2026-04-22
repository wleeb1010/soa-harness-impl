/**
 * §14.5 GET /events/recent — polling-friendly StreamEvent observability.
 *
 * Query params:
 *   session_id=<sid>       required for sessions:read scope; OPTIONAL
 *                          under admin:read (§14.5.5 L-47). When omitted
 *                          the response returns events across ALL
 *                          sessions in the current process boot.
 *   after=<event_id>       optional — pagination anchor
 *   limit=<n>              optional — 1..1000, default 100
 *   type=<StreamEventType> optional under admin:read — narrows result
 *                          to the named §14.1 closed-enum type
 *                          (e.g. ?type=CrashEvent for SV-STR-10).
 *                          Unknown value → 400.
 *
 * Auth: EITHER sessions:read:<sid> (session bearer) OR admin:read
 * (bootstrap bearer). Both → admin (broader). Neither → 401.
 * Rate limit:
 *   - sessions:read  → 120 rpm per bearer
 *   - admin:read     → 60 rpm per bearer (matches §14.5.3 / §10.5.3)
 * Readiness gate: 503 with §5.4 closed-enum reason when pre-boot.
 *
 * Body: events-recent-response.schema.json (pinned). Drift → 500.
 * Byte-identity: two reads of a quiescent channel are byte-equal when
 * `generated_at` is excluded.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import { STREAM_EVENT_TYPES, type StreamEventEmitter, type EmittedEvent } from "./emitter.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;
const STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(STREAM_EVENT_TYPES);

export interface EventsRecentRouteOptions {
  emitter: StreamEventEmitter;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  defaultLimit?: number;
  maxLimit?: number;
  /**
   * §14.5.5 admin:read bearer (Finding AE). When a request bears this
   * exact token, admin-scope semantics apply: session_id becomes
   * OPTIONAL, type filter is honored, rate limit drops to
   * adminRequestsPerMinute (default 60). Same bearer convention as
   * §14.5.3 backpressure + §10.5.3 audit-records admin surfaces.
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

export const eventsRecentPlugin: FastifyPluginAsync<EventsRecentRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 1000;
  const sessionLimiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const adminLimiter = new PerBearerLimiter(opts.adminRequestsPerMinute ?? 60, opts.clock);
  const responseValidator = schemaRegistry["events-recent-response"];

  app.get("/events/recent", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    // §14.5.5 scope hierarchy — admin:read always wins when both would
    // match; neither → 401. The bootstrap bearer carries admin:read by
    // the same M3 convention as §14.5.3 / §10.5.3.
    const isAdmin =
      opts.bootstrapBearer !== undefined && bearer === opts.bootstrapBearer;

    const rl = (isAdmin ? adminLimiter : sessionLimiter).consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const q = request.query as Record<string, unknown>;
    const sessionIdParam =
      typeof q["session_id"] === "string" ? (q["session_id"] as string) : undefined;
    const typeFilter = typeof q["type"] === "string" ? (q["type"] as string) : undefined;
    const after = typeof q["after"] === "string" ? (q["after"] as string) : undefined;
    const limitParam =
      typeof q["limit"] === "string" ? Number.parseInt(q["limit"] as string, 10) : undefined;

    if (typeFilter !== undefined && !STREAM_EVENT_TYPE_SET.has(typeFilter)) {
      return reply.code(400).send({ error: "unknown-stream-event-type" });
    }
    if (limitParam !== undefined && (!Number.isFinite(limitParam) || limitParam < 1)) {
      return reply.code(400).send({ error: "malformed-limit" });
    }
    const limit = Math.min(Math.max(limitParam ?? defaultLimit, 1), maxLimit);

    // Build the source event list per the effective scope.
    let all: EmittedEvent[];
    if (isAdmin) {
      // §14.5.5 — session_id is OPTIONAL under admin:read. When given,
      // restrict to that session (admin bearer still grants access — no
      // sessionStore bearer match required). When omitted, events span
      // all sessions in the current boot.
      if (sessionIdParam !== undefined) {
        if (!SESSION_ID_RE.test(sessionIdParam)) {
          return reply.code(400).send({ error: "malformed-session-id" });
        }
        all = opts.emitter.snapshot(sessionIdParam) as EmittedEvent[];
      } else {
        // Cross-session merge. §14.5.5 "events across ALL sessions in
        // the current process boot" — chronological by emitted_at then
        // by sequence within a session for deterministic ordering.
        all = collectAllSessionEvents(opts.emitter);
      }
    } else {
      // sessions:read:<sid> scope. session_id is REQUIRED here.
      if (!sessionIdParam || !SESSION_ID_RE.test(sessionIdParam)) {
        return reply.code(400).send({ error: "malformed-session-id" });
      }
      if (!opts.sessionStore.exists(sessionIdParam)) {
        return reply.code(404).send({ error: "unknown-session" });
      }
      if (!opts.sessionStore.validate(sessionIdParam, bearer)) {
        return reply.code(403).send({ error: "session-bearer-mismatch" });
      }
      all = opts.emitter.snapshot(sessionIdParam) as EmittedEvent[];
    }

    // Apply type filter if present (admin surface only for now per spec).
    const filtered =
      typeFilter !== undefined ? all.filter((e) => e.type === typeFilter) : all;

    let startIdx = 0;
    if (after !== undefined) {
      const idx = filtered.findIndex((e) => e.event_id === after);
      if (idx < 0) return reply.code(404).send({ error: "unknown-after-id" });
      startIdx = idx + 1;
    }
    const page = filtered.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < filtered.length;

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

    if (!responseValidator(body)) {
      return reply.code(500).send({
        error: "response-schema-violation",
        detail: JSON.stringify(responseValidator.errors ?? [])
      });
    }

    return reply.code(200).send(body);
  });
};

/**
 * Merge events across every session the emitter has seen, sorted by
 * (emitted_at, session_id, sequence) for deterministic ordering that's
 * stable across repeat calls to a quiescent channel (§14.5 byte-identity
 * property extended to admin scope per §14.5.5).
 */
function collectAllSessionEvents(emitter: StreamEventEmitter): EmittedEvent[] {
  const all: EmittedEvent[] = [];
  for (const sid of emitter.sessionIds()) {
    all.push(...emitter.snapshot(sid));
  }
  all.sort((a, b) => {
    if (a.emitted_at !== b.emitted_at) return a.emitted_at < b.emitted_at ? -1 : 1;
    if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
    return a.sequence - b.sequence;
  });
  return all;
}
