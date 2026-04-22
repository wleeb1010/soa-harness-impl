/**
 * §14.5.4 GET /logs/system/recent — polling System Event Log observability.
 *
 * Query params:
 *   session_id=<sid>         required — session scope
 *   category=<cat1,cat2,…>   optional — closed-enum filter; unknown → 400
 *   after=<record_id>        optional — pagination anchor (slog_ prefix)
 *   limit=<n>                optional — 1..1000, default 100
 *
 * Auth: sessions:read:<session_id> (same pattern as /events/recent).
 * Rate limit: 120 rpm per bearer.
 * Readiness gate: 503 with §5.4 closed-enum reason pre-boot.
 *
 * NOT-A-SIDE-EFFECT: defensive snapshot, no counters advance.
 * Body: system-log-recent-response.schema.json (pinned). Drift → 500.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import {
  SYSTEM_LOG_CATEGORIES,
  type SystemLogBuffer,
  type SystemLogCategory,
  type SystemLogRecord
} from "./buffer.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;
const CATEGORY_SET: ReadonlySet<string> = new Set<string>(SYSTEM_LOG_CATEGORIES);

export interface SystemLogRecentRouteOptions {
  buffer: SystemLogBuffer;
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

export const systemLogRecentPlugin: FastifyPluginAsync<SystemLogRecentRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultLimit = opts.defaultLimit ?? 100;
  const maxLimit = opts.maxLimit ?? 1000;
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const responseValidator = schemaRegistry["system-log-recent-response"];

  app.get("/logs/system/recent", async (request, reply) => {
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

    // Category filter parsing — comma-separated closed enum. Unknown
    // value → 400 BadRequest per §14.5.4.
    let categoryFilter: Set<SystemLogCategory> | undefined;
    const rawCat = q["category"];
    if (typeof rawCat === "string" && rawCat.length > 0) {
      const parts = rawCat.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const filter = new Set<SystemLogCategory>();
      for (const p of parts) {
        if (!CATEGORY_SET.has(p)) {
          return reply.code(400).send({
            error: "unknown-category",
            detail: `"${p}" is not in the §14.5.4 closed enum`
          });
        }
        filter.add(p as SystemLogCategory);
      }
      categoryFilter = filter;
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

    const all = opts.buffer.snapshot(sessionId, categoryFilter) as SystemLogRecord[];
    let startIdx = 0;
    if (after !== undefined) {
      const idx = all.findIndex((r) => r.record_id === after);
      if (idx < 0) return reply.code(404).send({ error: "unknown-after-id" });
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
      const last = page[page.length - 1]!;
      body["next_after"] = last.record_id;
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
