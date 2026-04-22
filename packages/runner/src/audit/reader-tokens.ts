/**
 * §10.5.7 L-48 Finding BJ — Audit-Reader Token Endpoint.
 *
 * POST /audit/reader-tokens (operator-bearer) mints short-TTL reader
 * bearers with ONLY audit:read:* scope:
 *   - GET /audit/tail → 200
 *   - GET /audit/records → 200
 *   - any POST/PUT/DELETE on any endpoint → 403
 *     {error:"bearer-lacks-audit-write-scope"}
 *   - any admin:read or sessions:read:* endpoint → 403
 *
 * Reader bearers live in an in-process store with (token → expires_at)
 * + lazy eviction on read. TTL range 60–3600s, default 900.
 */

import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";

/** Prefix that marks a bearer as an audit-reader token. */
export const READER_BEARER_PREFIX = "auditrdr_";

/** Paths that reader bearers ARE authorized to read. All are GET-only. */
const READER_ALLOWED_PATHS = new Set<string>([
  "/audit/tail",
  "/audit/records"
]);

export interface ReaderTokenRecord {
  token: string;
  expiresAtMs: number;
}

/**
 * In-process reader-token registry. Simple Map-backed; lazy eviction
 * on each lookup. For multi-instance deployments operators replace
 * this with a shared signed-JWT scheme; contract here is the boolean
 * "is this bearer an audit-reader?" gate.
 */
export class ReaderTokenStore {
  private readonly tokens = new Map<string, ReaderTokenRecord>();
  constructor(private readonly clock: Clock) {}

  mint(ttlSeconds: number): { token: string; expiresAt: string } {
    const now = this.clock().getTime();
    const expiresAtMs = now + ttlSeconds * 1000;
    const token = `${READER_BEARER_PREFIX}${randomBytes(18).toString("hex")}`;
    this.tokens.set(token, { token, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** True when the token is a live, non-expired reader bearer. Lazy-evicts expired entries. */
  isValid(token: string): boolean {
    const rec = this.tokens.get(token);
    if (rec === undefined) return false;
    if (this.clock().getTime() >= rec.expiresAtMs) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Size — for tests + operator introspection. Runs lazy eviction first. */
  size(): number {
    const now = this.clock().getTime();
    for (const [t, rec] of this.tokens) {
      if (now >= rec.expiresAtMs) this.tokens.delete(t);
    }
    return this.tokens.size;
  }
}

/** True when the bearer syntactically claims reader scope (before expiry check). */
export function looksLikeReaderBearer(bearer: string): boolean {
  return bearer.startsWith(READER_BEARER_PREFIX);
}

/** True when the given path is one a reader bearer is authorized to read. */
export function readerAllowedPath(method: string, url: string): boolean {
  if (method !== "GET") return false;
  // Strip query string from path.
  const q = url.indexOf("?");
  const path = q >= 0 ? url.slice(0, q) : url;
  return READER_ALLOWED_PATHS.has(path);
}

export interface ReaderTokensRouteOptions {
  store: ReaderTokenStore;
  clock: Clock;
  readiness: ReadinessProbe;
  runnerVersion?: string;
  /** Operator bearer required to mint reader tokens. When undefined, endpoint is effectively disabled (401). */
  operatorBearer?: string;
  /** Default TTL if body omits ttl_seconds. Default 900. */
  defaultTtlSeconds?: number;
}

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? match[1] ?? null : null;
}

export const auditReaderTokensPlugin: FastifyPluginAsync<ReaderTokensRouteOptions> = async (
  app,
  opts
) => {
  const defaultTtl = opts.defaultTtlSeconds ?? 900;
  const runnerVersion = opts.runnerVersion ?? "1.0";

  app.post("/audit/reader-tokens", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    if (opts.operatorBearer === undefined || bearer !== opts.operatorBearer) {
      return reply.code(403).send({ error: "bearer-lacks-operator-scope" });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const raw = body["ttl_seconds"];
    let ttl: number;
    if (raw === undefined) {
      ttl = defaultTtl;
    } else if (typeof raw === "number" && Number.isInteger(raw)) {
      ttl = raw;
    } else {
      return reply.code(400).send({ error: "malformed-ttl-seconds" });
    }
    if (ttl < 60 || ttl > 3600) {
      return reply.code(400).send({ error: "ttl-seconds-out-of-range" });
    }

    const { token, expiresAt } = opts.store.mint(ttl);
    return reply.code(201).send({
      reader_bearer: token,
      expires_at: expiresAt,
      scope: "audit:read:*",
      runner_version: runnerVersion
    });
  });
};

/**
 * Fastify onRequest hook factory — rejects reader bearers on any path
 * outside the audit-read allow-list with 403 bearer-lacks-audit-write-scope.
 * Registered at the app level so every route inherits the guard.
 */
export function makeReaderScopeGuard(store: ReaderTokenStore) {
  return async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    const bearer = extractBearer(request);
    if (!bearer) return; // unauthenticated — per-route decides
    if (!looksLikeReaderBearer(bearer)) return; // non-reader bearer — per-route decides
    // It's a reader bearer. Check validity first so an expired token
    // surfaces a recognizable error shape.
    if (!store.isValid(bearer)) {
      return reply.code(401).send({ error: "reader-bearer-expired" });
    }
    // Valid reader — gate by path.
    const url = request.url;
    if (!readerAllowedPath(request.method, url)) {
      return reply.code(403).send({ error: "bearer-lacks-audit-write-scope" });
    }
    // Path-allowed; route handlers still run. tail-route + records-route
    // extend their audit-read predicate to accept reader bearers.
  };
}
