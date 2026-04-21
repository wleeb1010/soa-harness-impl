import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ToolRegistry } from "../registry/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { Clock } from "../clock/index.js";
import type { Capability } from "./types.js";
import type { Control } from "../registry/types.js";
import { resolvePermissionForQuery } from "./resolve-for-query.js";
import type { SessionStore } from "./session-store.js";

export interface PermissionsResolveRouteOptions {
  registry: ToolRegistry;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  activeCapability: Capability;
  toolRequirements?: Record<string, Control>;
  policyEndpoint?: string;
  runnerVersion?: string;
  /** Requests per 60-second window per bearer. §10.3.1 requires ≤ 60. */
  requestsPerMinute?: number;
}

// Guard against query-parameter content that could trip a schema validator or
// show up in audit logs later; the §10.3.1 404 path covers unknown tool / session,
// but a malformed-looking string should 400 before even reaching the lookup.
const VALID_PARAM_RE = /^[A-Za-z0-9_.:\-]+$/;
const WINDOW_MS = 60_000;

class BearerRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly now: Clock) {}

  consume(bearerHash: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    const fresh = (this.windows.get(bearerHash) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      const retry = Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000));
      this.windows.set(bearerHash, fresh);
      return { allowed: false, retryAfterSeconds: retry };
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

export const permissionsResolvePlugin: FastifyPluginAsync<PermissionsResolveRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new BearerRateLimiter(opts.requestsPerMinute ?? 60, opts.clock);

  app.get("/permissions/resolve", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    // Readiness gate — §10.3.1: 503 body conforms to §5.4 readiness-failure shape.
    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    // Auth: bearer presence. Missing header OR non-Bearer scheme → 401.
    const bearer = extractBearer(request);
    if (!bearer) {
      return reply.code(401).send({ error: "missing-or-invalid-bearer" });
    }
    const bearerHash = sha256Hex(bearer);

    // Rate limit (per bearer, 60s window).
    const rl = limiter.consume(bearerHash);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    // Query-parameter shape.
    const q = request.query as Record<string, unknown>;
    const toolName = typeof q["tool"] === "string" ? (q["tool"] as string) : null;
    const sessionId = typeof q["session_id"] === "string" ? (q["session_id"] as string) : null;
    if (!toolName || !sessionId || !VALID_PARAM_RE.test(toolName) || !VALID_PARAM_RE.test(sessionId)) {
      return reply.code(400).send({ error: "malformed-query" });
    }

    // Session. Unknown session_id → 404; known but bearer mismatch → 403.
    if (!opts.sessionStore.exists(sessionId)) {
      return reply.code(404).send({ error: "unknown-session" });
    }
    if (!opts.sessionStore.validate(sessionId, bearer)) {
      return reply.code(403).send({ error: "bearer-not-authorized-for-session" });
    }

    // Tool lookup.
    const tool = opts.registry.lookup(toolName);
    if (!tool) {
      return reply.code(404).send({ error: "unknown-tool" });
    }

    // Resolve §10.3 steps 1–4 — no side effects.
    const response = resolvePermissionForQuery({
      tool,
      // §10.3 step 1 (post-§12.6 update): capability comes from the session's
      // granted_activeMode, not the Agent Card's. The Card's value gated
      // session creation; the session's is what constrains this request.
      capability: opts.sessionStore.getRecord(sessionId)?.activeMode ?? opts.activeCapability,
      ...(opts.toolRequirements?.[tool.name] !== undefined
        ? { toolRequirement: opts.toolRequirements[tool.name] as Control }
        : {}),
      ...(opts.policyEndpoint !== undefined ? { policyEndpoint: opts.policyEndpoint } : {}),
      now: opts.clock,
      runnerVersion
    });

    return reply.code(200).send(response);
  });
};
