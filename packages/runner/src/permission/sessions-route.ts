import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import { CAPABILITY_PERMITS, type Capability } from "./types.js";
import { InMemorySessionStore } from "./session-store.js";
import type { SessionPersister, PersistedSession } from "../session/index.js";
import type { StreamEventEmitter } from "../stream/index.js";
import type { InMemoryMemoryStateStore } from "../memory/index.js";
import { MemoryTimeout, type MemoryMcpClient, type MemoryDegradationTracker } from "../memory/index.js";
import type { BudgetTracker } from "../budget/index.js";

export interface SessionsRouteOptions {
  sessionStore: InMemorySessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  /** Agent Card permissions.activeMode — upper bound for granted_activeMode. */
  cardActiveMode: Capability;
  /** Fixed bootstrap bearer. Loopback listeners only per §12.6. */
  bootstrapBearer: string;
  /** Seconds. Default 3600 (1h). Clamped to [60, 86400]. */
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  runnerVersion?: string;
  requestsPerMinute?: number;
  /**
   * §12.6 Normative MUST — "The Runner MUST persist the session file (§12.1)
   * before returning 201." The handler synthesizes a Planning-state session
   * file from the request and writes it atomically via SessionPersister
   * BEFORE the 201 body is sent. A persist failure surfaces as 503
   * persistence-unwritable — the client can retry, but the spec MUST
   * requires that 201 implies on-disk existence.
   *
   * Not optional in production — but left optional here so unit tests that
   * exercise the in-memory-only flow (e.g., malformed-request branches that
   * never reach the persist step) can omit it.
   */
  persister?: SessionPersister;
  /**
   * Tool pool hash to embed in the session file (§12.1 tool_pool_hash).
   * Required when `persister` is set. The bin passes the current Tool
   * Registry's hash so §12.5 step 3 can detect registry drift at resume.
   */
  toolPoolHash?: string;
  /**
   * Agent Card version to embed in the session file (§12.1 card_version).
   * Required when `persister` is set. The bin passes card.version so
   * §12.5 step 2 can detect card drift at resume.
   */
  cardVersion?: string;
  /**
   * M3-T2 StreamEvent emitter. When present, a `SessionStart` event fires
   * per §14.1 after successful persist-before-201. Optional; when omitted
   * the plugin doesn't emit (backwards-compat for tests that don't
   * exercise the stream surface).
   */
  emitter?: StreamEventEmitter;
  /** Agent Card `name` — embedded in SessionStart payload (required field). */
  agentName?: string;
  /**
   * M3-T1 Memory state store. When present, each new session gets a
   * zero-state initialized (empty in_context_notes, consolidation.
   * last_run_at = now) so GET /memory/state returns a schema-valid
   * body from the moment the session exists.
   */
  memoryStore?: InMemoryMemoryStateStore;
  /** M3-T4 Budget tracker — initFor() called at session bootstrap. */
  budgetTracker?: BudgetTracker;
  /**
   * M3-T13 HR-17 — when configured, each new session attempts one
   * Memory MCP prefetch (§8.2). On MemoryTimeout, the runner emits
   * SessionEnd{stop_reason:"MemoryDegraded"} per §8.3.1 before the
   * 201 returns. HR-17 choreography: 3 sessions × TIMEOUT_AFTER_N_CALLS=0
   * → 3 SessionEnd events with MemoryDegraded stop_reason.
   */
  memoryClient?: MemoryMcpClient;
  memoryDegradation?: MemoryDegradationTracker;
}

const WINDOW_MS = 60_000;
const TTL_MIN = 60;
const TTL_MAX = 86_400;
const CAP_RANK: Record<Capability, number> = { ReadOnly: 0, WorkspaceWrite: 1, DangerFullAccess: 2 };

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? (match[1] ?? null) : null;
}

class BootstrapLimiter {
  private readonly hits: number[] = [];
  constructor(private readonly limit: number, private readonly now: Clock) {}
  consume(): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    while (this.hits.length > 0 && t - (this.hits[0] ?? t) >= WINDOW_MS) this.hits.shift();
    if (this.hits.length >= this.limit) {
      const oldest = this.hits[0] ?? t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000)) };
    }
    this.hits.push(t);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

interface BootstrapRequest {
  requested_activeMode?: unknown;
  user_sub?: unknown;
  session_ttl_seconds?: unknown;
  /**
   * T-03: when `true`, the returned session_bearer carries the
   * `permissions:decide:<session_id>` scope in addition to the default
   * `stream:read:<sid>` + `permissions:resolve:<sid>` + `audit:read`.
   * Default false. `sessions:create` is never carried on session bearers.
   */
  request_decide_scope?: unknown;
}

export const sessionsBootstrapPlugin: FastifyPluginAsync<SessionsRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultTtl = Math.min(Math.max(opts.defaultTtlSeconds ?? 3600, TTL_MIN), TTL_MAX);
  const maxTtl = Math.min(opts.maxTtlSeconds ?? TTL_MAX, TTL_MAX);
  const limiter = new BootstrapLimiter(opts.requestsPerMinute ?? 30, opts.clock);
  const validModes = new Set(Object.keys(CAPABILITY_PERMITS) as Capability[]);

  app.post("/sessions", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (bearer !== opts.bootstrapBearer) {
      return reply.code(401).send({ error: "missing-or-invalid-bootstrap-bearer" });
    }

    const rl = limiter.consume();
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const body = (request.body ?? {}) as BootstrapRequest;
    const requested = body.requested_activeMode;
    const userSub = body.user_sub;
    const ttlRaw = body.session_ttl_seconds;

    if (typeof requested !== "string" || !validModes.has(requested as Capability)) {
      return reply.code(400).send({ error: "malformed-request", detail: "requested_activeMode missing or invalid" });
    }
    if (typeof userSub !== "string" || userSub.length === 0) {
      return reply.code(400).send({ error: "malformed-request", detail: "user_sub missing" });
    }
    let ttlSeconds: number = defaultTtl;
    if (ttlRaw !== undefined) {
      if (typeof ttlRaw !== "number" || !Number.isInteger(ttlRaw) || ttlRaw < TTL_MIN || ttlRaw > TTL_MAX) {
        return reply.code(400).send({ error: "malformed-request", detail: `session_ttl_seconds must be an integer in [${TTL_MIN}, ${TTL_MAX}]` });
      }
      ttlSeconds = Math.min(ttlRaw, maxTtl);
    }

    // T-03: request_decide_scope must be boolean when present.
    const rawDecideScope = body.request_decide_scope;
    if (rawDecideScope !== undefined && typeof rawDecideScope !== "boolean") {
      return reply
        .code(400)
        .send({ error: "malformed-request", detail: "request_decide_scope must be a boolean" });
    }
    const canDecide = rawDecideScope === true;

    const requestedMode = requested as Capability;
    if (CAP_RANK[requestedMode] > CAP_RANK[opts.cardActiveMode]) {
      return reply.code(403).send({
        error: "ConfigPrecedenceViolation",
        detail: `requested_activeMode=${requestedMode} exceeds Agent Card permissions.activeMode=${opts.cardActiveMode}`
      });
    }

    const created = opts.sessionStore.create({
      activeMode: requestedMode,
      user_sub: userSub,
      ttlSeconds,
      now: opts.clock(),
      canDecide
    });

    // §12.6 MUST — persist the session file BEFORE returning 201. A 201
    // response implies the session exists on disk and will survive a
    // Runner crash between POST and the client's next call. Without this,
    // /sessions/:id/state 404s on disk-read even though the session is
    // in-memory — the cross-endpoint consistency bug validators surface.
    if (opts.persister) {
      const toolPoolHash = opts.toolPoolHash;
      const cardVersion = opts.cardVersion;
      if (toolPoolHash === undefined || cardVersion === undefined) {
        // Operator configuration error — surface loudly rather than ship a
        // schema-violating session file to disk.
        opts.sessionStore.revoke(created.session_id);
        return reply.code(500).send({
          error: "session-persist-misconfigured",
          detail: "persister supplied without toolPoolHash or cardVersion"
        });
      }
      const nowIso = opts.clock().toISOString();
      const file: PersistedSession = {
        session_id: created.session_id,
        format_version: "1.0",
        activeMode: created.record.activeMode,
        created_at: nowIso,
        messages: [],
        workflow: {
          // Placeholder task_id — the actual task arrives with the first
          // tool invocation (§12.2 bracket-persist). session.schema.json
          // requires the field; using the session_id keeps it unique and
          // grep-friendly for operators inspecting the pending queue.
          task_id: `bootstrap-${created.session_id}`,
          status: "Planning",
          side_effects: [],
          checkpoint: {}
        },
        counters: {},
        tool_pool_hash: toolPoolHash,
        card_version: cardVersion
      } as PersistedSession;
      try {
        await opts.persister.writeSession(file);
      } catch (err) {
        // Persist failure → the session doesn't survive a crash, so §12.6
        // MUST is violated. Roll back the in-memory registration and
        // surface 503 persistence-unwritable. Client MAY retry.
        opts.sessionStore.revoke(created.session_id);
        return reply.code(503).send({
          status: "not-ready",
          reason: "persistence-unwritable",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // M3-T1 init Memory state so /memory/state returns a schema-valid
    // body for this session immediately. Full §8 client wiring (search /
    // write / consolidate) lands incrementally alongside SV-MEM-01..08.
    if (opts.memoryStore) {
      opts.memoryStore.initFor({ session_id: created.session_id });
    }
    if (opts.budgetTracker) {
      opts.budgetTracker.initFor(created.session_id);
    }

    // §14.1 SessionStart after persist-before-201 so the event sequence
    // for this session begins with sequence=0 and event_id-stable
    // pagination works from the first read.
    if (opts.emitter) {
      opts.emitter.emit({
        session_id: created.session_id,
        type: "SessionStart",
        payload: {
          agent_name: opts.agentName ?? "soa-harness-runner",
          agent_version: runnerVersion,
          card_version: opts.cardVersion ?? "1.0",
          resumed: false
        }
      });
    }

    // M3-T13 HR-17 §8.3 — attempt a Memory MCP prefetch. Timeout emits
    // SessionEnd{stop_reason:"MemoryDegraded"} per §8.3.1. The 201 still
    // returns (session was created + persisted); the client sees the
    // degradation on their next /events/recent poll.
    if (opts.memoryClient && opts.emitter) {
      try {
        const hits = await opts.memoryClient.searchMemories({
          query: userSub,
          limit: 5,
          sharing_scope: "session"
        });
        if (opts.memoryDegradation) opts.memoryDegradation.recordSuccess();
        // Record in the memory-state store so /memory/state reflects the load.
        if (opts.memoryStore) {
          opts.memoryStore.recordLoad(
            created.session_id,
            hits.notes.map((n) => ({
              note_id: n.note_id,
              summary: n.summary,
              data_class: n.data_class,
              composite_score: n.composite_score,
              ...(n.weight_semantic !== undefined ? { weight_semantic: n.weight_semantic } : {}),
              ...(n.weight_recency !== undefined ? { weight_recency: n.weight_recency } : {}),
              ...(n.weight_graph_strength !== undefined
                ? { weight_graph_strength: n.weight_graph_strength }
                : {})
            })),
            hits.notes.length
          );
        }
      } catch (err) {
        if (err instanceof MemoryTimeout) {
          if (opts.memoryDegradation) opts.memoryDegradation.recordFailure();
          // §8.3.1 — SessionEnd with stop_reason=MemoryDegraded.
          opts.emitter.emit({
            session_id: created.session_id,
            type: "SessionEnd",
            payload: { stop_reason: "MemoryDegraded" }
          });
        } else {
          // Non-timeout error: log but don't degrade; future milestone
          // may expand the failure taxonomy (auth, schema, etc.).
          console.warn(
            `[sessions] Memory MCP non-timeout error for ${created.session_id}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    return reply.code(201).send({
      session_id: created.session_id,
      session_bearer: created.session_bearer,
      granted_activeMode: created.record.activeMode,
      expires_at: created.record.expires_at.toISOString(),
      runner_version: runnerVersion
    });
  });
};
