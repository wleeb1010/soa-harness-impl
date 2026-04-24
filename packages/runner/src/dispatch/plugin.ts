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
import type { InMemoryTestAdapter } from "./test-double.js";
import type { ProviderAdapter } from "./adapter.js";
import type { DispatchRequest } from "./types.js";
import { InFlightRegistry, runStreamDispatch } from "./stream.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const CORRELATION_ID_RE = /^cor_[A-Za-z0-9]{16,}$/;
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
  /**
   * Optional — the adapter wired into the dispatcher. When this is the
   * InMemoryTestAdapter, the plugin exposes POST /dispatch/debug/set-behavior
   * (admin-only) so conformance probes can drive fault injection at runtime
   * without restarting the Runner. Real adapters leave the debug route
   * unregistered (404) — a production leak of this is defense-in-depth
   * impossible because the adapter type check gates the registration.
   *
   * This same adapter (when non-undefined) is the source of the optional
   * `dispatchStream` method for §16.6 streaming mode. If the adapter
   * implements `dispatchStream`, `POST /dispatch` with
   * `Accept: text/event-stream` returns an SSE response; otherwise the Runner
   * returns HTTP 406 with `DispatcherStreamUnsupported` per §16.6.2.
   */
  adapterForDebug?: ProviderAdapter;
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
  const runnerVersion = opts.runnerVersion ?? "1.2";
  const sessionLimiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const adminLimiter = new PerBearerLimiter(opts.adminRequestsPerMinute ?? 60, opts.clock);
  const requestValidator = schemaRegistry["llm-dispatch-request"];
  const recentResponseValidator = schemaRegistry["dispatch-recent-response"];
  const inflight = new InFlightRegistry();

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

    // §16.6.2 — streaming mode trigger: Accept: text/event-stream AND body
    // stream: true (stream is schema-default so absence counts as true). If
    // the adapter wired into this dispatcher lacks dispatchStream, return
    // HTTP 406 with DispatcherStreamUnsupported — the audit row is written
    // by recordStreamDispatch with the matching error code.
    const acceptHdr = (request.headers["accept"] ?? "") as string;
    const wantsSse = acceptHdr.split(",").some((v) => v.trim().startsWith("text/event-stream"));
    const bodyStream = req.stream !== false; // schema default is true
    const streamingRequested = wantsSse && bodyStream;

    if (streamingRequested) {
      const streamingAdapter = opts.adapterForDebug;
      if (!streamingAdapter || streamingAdapter.dispatchStream === undefined) {
        // Record the DispatcherStreamUnsupported audit row before returning,
        // so /audit/tail observes the failure per §16.6.2 step 1.
        opts.dispatcher.recordStreamDispatch({
          request: req,
          stop_reason: "DispatcherError",
          dispatcher_error_code: "DispatcherStreamUnsupported",
          usage: { input_tokens: 0, output_tokens: 0 },
          started_at: opts.clock().toISOString(),
          completed_at: opts.clock().toISOString(),
        });
        return reply.code(406).send({
          dispatcher_error_code: "DispatcherStreamUnsupported",
          detail: "adapter does not implement dispatchStream",
        });
      }
      await runStreamDispatch({
        request: req,
        dispatcher: opts.dispatcher,
        adapter: streamingAdapter,
        reply,
        inflight,
      });
      return;
    }

    const dispatchResponse = await opts.dispatcher.dispatch(req);
    // All successful + error-classified responses come back as valid
    // DispatchResponse — dispatcher preserves HTTP 200 semantics; the
    // stop_reason + dispatcher_error_code surface failure detail.
    return reply.code(200).send(dispatchResponse);
  });

  // ────────────────────────────────────────────────────────────────────────
  // POST /dispatch/:correlation_id/cancel — §16.6.4 mid-stream cancellation
  // ────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { correlation_id: string } }>(
    "/dispatch/:correlation_id/cancel",
    async (request, reply) => {
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

      const { correlation_id } = request.params;
      if (!CORRELATION_ID_RE.test(correlation_id)) {
        return reply.code(400).send({ error: "malformed-correlation-id" });
      }

      // No in-flight dispatch → 404. Harder than "succeed anyway" but lets the
      // test suite distinguish "the cancel landed before the stream started"
      // from "the cancel landed mid-stream".
      if (!inflight.has(correlation_id)) {
        return reply.code(404).send({ error: "no-in-flight-dispatch" });
      }

      inflight.cancel(correlation_id);
      return reply.code(202).send({ cancelling: true });
    },
  );

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

  // ────────────────────────────────────────────────────────────────────────
  // POST /dispatch/debug/set-behavior — conformance-probe fault injection.
  //
  // Only registered when the adapter wired into the dispatcher is the
  // in-memory test-double. Real adapters never expose this route. Admin-
  // bearer only — no session-bearer path. Accepts {"behavior": "<dsl>"}
  // per the InMemoryTestAdapter behavior DSL.
  // ────────────────────────────────────────────────────────────────────────
  const adapter = opts.adapterForDebug;
  const isTestDouble =
    adapter !== undefined &&
    typeof (adapter as InMemoryTestAdapter).setBehavior === "function" &&
    adapter.name === "in-memory-test-adapter";

  if (isTestDouble && opts.bootstrapBearer !== undefined) {
    const td = adapter as InMemoryTestAdapter;
    const admin = opts.bootstrapBearer;
    app.post("/dispatch/debug/set-behavior", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const bearer = extractBearer(request);
      if (bearer !== admin) return reply.code(403).send({ error: "admin-only" });
      const body = request.body as Record<string, unknown> | null;
      const behavior = body && typeof body["behavior"] === "string" ? (body["behavior"] as string) : null;
      if (behavior === null) return reply.code(400).send({ error: "missing-behavior" });
      td.setBehavior(behavior);
      return reply.code(200).send({ status: "ok", behavior });
    });
  }
};
