import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/index.js";
import type { SystemLogBuffer } from "../system-log/index.js";
import { AuditChain } from "./chain.js";
import type { ReaderTokenStore } from "./reader-tokens.js";
import { looksLikeReaderBearer } from "./reader-tokens.js";

export interface AuditRecordsRouteOptions {
  chain: AuditChain;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /** §10.5.3 default 60 rpm per bearer. */
  requestsPerMinute?: number;
  /** Default page size. Default 100. */
  defaultLimit?: number;
  /** Schema-pinned max page size. 1000. */
  maxLimit?: number;
  /**
   * §10.5.5 Finding BC — System Event Log for ImmutableAuditSink
   * record emission when PUT/DELETE is rejected under WORM mode.
   * Optional — when unset, the 405 still fires but no log record.
   */
  systemLog?: SystemLogBuffer;
  /** §10.5.5 session_id for the ImmutableAuditSink log record (BOOT_SESSION_ID). */
  bootSessionId?: string;
  /** §10.5.7 Finding BJ — reader bearers bypass session-bearer audit:read. */
  readerTokens?: ReaderTokenStore;
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

function bearerAuthorizedForAuditRead(store: SessionStore, bearer: string): boolean {
  const maybe = (store as unknown as { anySession?: (b: string) => boolean }).anySession;
  return typeof maybe === "function" ? maybe.call(store, bearer) : false;
}

export const auditRecordsPlugin: FastifyPluginAsync<AuditRecordsRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 1000;
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);

  app.get("/audit/records", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });

    // §10.5.7 Finding BJ — reader bearers carry audit:read:* scope.
    const isReader =
      looksLikeReaderBearer(bearer) &&
      opts.readerTokens !== undefined &&
      opts.readerTokens.isValid(bearer);

    if (!isReader && !bearerAuthorizedForAuditRead(opts.sessionStore, bearer)) {
      return reply.code(403).send({ error: "bearer-lacks-audit-read-scope" });
    }

    const rl = limiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const q = request.query as Record<string, unknown>;
    const after = typeof q["after"] === "string" ? (q["after"] as string) : undefined;
    const limitParam = typeof q["limit"] === "string" ? Number.parseInt(q["limit"] as string, 10) : undefined;
    if (limitParam !== undefined && (!Number.isFinite(limitParam) || limitParam < 1)) {
      return reply.code(400).send({ error: "malformed-limit" });
    }
    const limit = Math.min(Math.max(limitParam ?? defaultLimit, 1), maxLimit);

    const all = opts.chain.snapshot();
    let startIdx = 0;
    if (after !== undefined) {
      const idx = all.findIndex((r) => r["id"] === after);
      if (idx < 0) {
        return reply.code(404).send({ error: "unknown-after-id" });
      }
      startIdx = idx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;

    const body: Record<string, unknown> = {
      records: page,
      has_more: hasMore,
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (page.length > 0) {
      const last = page[page.length - 1];
      if (last && typeof last["id"] === "string") body["next_after"] = last["id"];
    }

    return reply.code(200).send(body);
  });

  // §10.5.5 L-48 Finding BC — WORM sink immutability. Mutating /audit
  // records via HTTP is never permitted in any mode, but under the
  // worm-in-memory sink we surface the rejection with the specific
  // ImmutableAuditSink shape AND mirror it onto /logs/system/recent so
  // validators observe both the HTTP response and the Audit-category
  // log record. Outside WORM mode this path returns the same shape for
  // structural consistency — audit mutation is never legitimate regardless.
  const mutationHandler = async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    reply.header("Cache-Control", "no-store");
    const params = request.params as { id?: string };
    const body = {
      error: "ImmutableAuditSink",
      reason: "worm-sink-forbids-mutation"
    };
    if (opts.systemLog !== undefined && opts.bootSessionId !== undefined) {
      opts.systemLog.write({
        session_id: opts.bootSessionId,
        category: "Audit",
        level: "error",
        code: "ImmutableAuditSink",
        message:
          `ImmutableAuditSink: ${request.method} /audit/records/${params.id ?? "<missing>"} rejected — ` +
          `§10.5.5 WORM sink forbids mutation`,
        data: {
          method: request.method,
          record_id: params.id,
          sink_mode: opts.chain.isWormSink() ? "worm-in-memory" : "non-worm"
        }
      });
    }
    return reply.code(405).send(body);
  };
  app.put("/audit/records/:id", mutationHandler);
  app.delete("/audit/records/:id", mutationHandler);
};
