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
import type { SystemLogBuffer } from "../system-log/index.js";
import {
  negotiateCoreVersion,
  parseSupportedCoreVersions,
  RUNNER_SUPPORTED_CORE_VERSIONS
} from "../governance/index.js";
import { partitionSensitivePersonal } from "../privacy/index.js";

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
  /**
   * §14.2 System Event Log — Finding T (SV-MEM-04) writes per-timeout
   * MemoryDegraded records here without terminating the session. Only
   * 3-consecutive timeouts (tracked by MemoryDegradationTracker) escalate
   * to SessionEnd{stop_reason:"MemoryDegraded"}. Omit to preserve the
   * pre-L-38 single-strike behavior (kept so legacy tests don't rely on
   * the log buffer being wired).
   */
  systemLog?: SystemLogBuffer;
  /**
   * §8.5 default sharing_scope for the bootstrap-time searchMemories
   * prefetch. Finding V / SV-MEM-06: pulled from
   * card.memory.default_sharing_scope. Fallback to "session" (least-
   * privilege) when the card omits. Valid values: "none" | "session" |
   * "project" | "tenant" (SharingPolicy enum from §8.5).
   */
  memoryDefaultSharingScope?: "none" | "session" | "project" | "tenant";
  /**
   * §7 card.tokenBudget.billingTag — stamped on the new session record
   * AND on the persisted session file for post-hoc billing attribution.
   * Finding Q (SV-BUD-05). Finding R's BillingTagMismatch gate
   * (incoming request.billing_tag ≠ card) layers on top.
   */
  cardBillingTag?: string;
  /**
   * §19.4.1 wire-level version negotiation — Runner's advertised
   * supported set. When the request body supplies
   * `supported_core_versions`, the intersection with this set MUST be
   * non-empty; empty intersection → 400 `VersionNegotiationFailed`
   * (SV-GOV-08). Absent from the request body = caller accepts the
   * Runner's declared set implicitly. Default: `["1.0"]`.
   */
  supportedCoreVersions?: readonly string[];
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
  /**
   * Finding R / SV-BUD-07 — optional request-supplied billing_tag.
   * When present AND the Runner's card.tokenBudget.billingTag is set,
   * divergence raises §24 BillingTagMismatch (403). Omitting the field
   * accepts the card's value implicitly.
   */
  billing_tag?: unknown;
  /**
   * §19.4.1 SV-GOV-08 — caller's advertised supported Core versions.
   * Optional; when omitted, caller accepts Runner's declared set.
   * When present, intersection with Runner's set MUST be non-empty.
   */
  supported_core_versions?: unknown;
}

export const sessionsBootstrapPlugin: FastifyPluginAsync<SessionsRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const defaultTtl = Math.min(Math.max(opts.defaultTtlSeconds ?? 3600, TTL_MIN), TTL_MAX);
  const maxTtl = Math.min(opts.maxTtlSeconds ?? TTL_MAX, TTL_MAX);
  const limiter = new BootstrapLimiter(opts.requestsPerMinute ?? 30, opts.clock);
  const validModes = new Set(Object.keys(CAPABILITY_PERMITS) as Capability[]);
  const runnerSupported = opts.supportedCoreVersions ?? RUNNER_SUPPORTED_CORE_VERSIONS;

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

    // §19.4.1 SV-GOV-08 — wire-level version negotiation. When the
    // caller advertises a supported_core_versions set, intersect it
    // with the Runner's set; empty intersection aborts the bootstrap
    // with VersionNegotiationFailed per §24. Absent-field = implicit
    // acceptance of the Runner's declared set (no negotiation
    // failure possible). Runs BEFORE capability + billing-tag gates
    // because §19.4.1 treats negotiation as the session-establishment
    // precondition: no point in clamping activeMode or enforcing
    // billing equality against a Card the caller's wire version can't
    // even negotiate.
    const rawSupportedVersions = body.supported_core_versions;
    if (rawSupportedVersions !== undefined) {
      const parsed = parseSupportedCoreVersions(rawSupportedVersions);
      if (!Array.isArray(parsed)) {
        return reply.code(400).send({ error: "malformed-request", detail: parsed.error });
      }
      const negotiated = negotiateCoreVersion(parsed, runnerSupported);
      if (negotiated === null) {
        return reply.code(400).send({
          error: "VersionNegotiationFailed",
          detail:
            `supported_core_versions intersection is empty — caller advertises ` +
            `${JSON.stringify(parsed)}, Runner supports ${JSON.stringify([...runnerSupported])}`,
          runner_supported_core_versions: [...runnerSupported],
          caller_supported_core_versions: parsed
        });
      }
    }

    const requestedMode = requested as Capability;
    if (CAP_RANK[requestedMode] > CAP_RANK[opts.cardActiveMode]) {
      return reply.code(403).send({
        error: "ConfigPrecedenceViolation",
        detail: `requested_activeMode=${requestedMode} exceeds Agent Card permissions.activeMode=${opts.cardActiveMode}`
      });
    }

    // Finding R / SV-BUD-07 — §24 BillingTagMismatch. When the request
    // body supplies billing_tag AND the card declares one, they MUST
    // match. Body omitting billing_tag implicitly accepts the card's
    // value. Card omitting billingTag (e.g., pre-L-37 fixtures) skips
    // the gate entirely — no divergence to detect.
    const rawBillingTag = body.billing_tag;
    if (rawBillingTag !== undefined && typeof rawBillingTag !== "string") {
      return reply.code(400).send({
        error: "malformed-request",
        detail: "billing_tag must be a string"
      });
    }
    if (
      typeof rawBillingTag === "string" &&
      typeof opts.cardBillingTag === "string" &&
      rawBillingTag !== opts.cardBillingTag
    ) {
      return reply.code(403).send({
        error: "BillingTagMismatch",
        detail:
          `request billing_tag="${rawBillingTag}" does not match Agent Card ` +
          `tokenBudget.billingTag="${opts.cardBillingTag}" per §7 line 1821`
      });
    }

    const created = opts.sessionStore.create({
      activeMode: requestedMode,
      user_sub: userSub,
      ttlSeconds,
      now: opts.clock(),
      canDecide,
      ...(opts.cardBillingTag !== undefined ? { billing_tag: opts.cardBillingTag } : {})
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
        card_version: cardVersion,
        // Finding Q — billing_tag follows the card's tokenBudget.billingTag
        // (§7 line 1821 equality is the premise for Finding R's divergence
        // detection). session.schema.json is open so the extra field
        // rides along cleanly.
        ...(opts.cardBillingTag !== undefined
          ? { billing_tag: opts.cardBillingTag }
          : {})
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
          // Finding V / SV-MEM-06: honor card.memory.default_sharing_scope
          // when declared; fall back to "session" least-privilege default.
          sharing_scope: opts.memoryDefaultSharingScope ?? "session"
        });
        if (opts.memoryDegradation) opts.memoryDegradation.recordSuccess();
        // §10.7 SV-PRIV-02 / Finding AG — drop sensitive-personal notes
        // BEFORE recordLoad so state-store's invariant never trips, and
        // emit one MemoryDeletionForbidden system-log record per
        // forbidden note (category=Error, code=MemoryDeletionForbidden,
        // data.reason=sensitive-class-forbidden). The safe slice still
        // flows into in-context state; the forbidden notes are
        // observable via GET /logs/system/recent but never persisted.
        const partitioned = partitionSensitivePersonal(
          hits.hits,
          created.session_id,
          opts.systemLog
        );
        // Record in the memory-state store so /memory/state reflects the load.
        if (opts.memoryStore) {
          opts.memoryStore.recordLoad(
            created.session_id,
            partitioned.safe.map((n) => ({
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
            partitioned.safe.length
          );
        }
      } catch (err) {
        if (err instanceof MemoryTimeout) {
          // Finding T / SV-MEM-04 — §8.3 two-tier behavior:
          //   per-timeout (non-terminal): write MemoryDegraded System
          //     Event Log record (level=warn, category=MemoryDegraded)
          //     and CONTINUE with stale slice (the session was already
          //     persisted at 201; the 201 response flows normally).
          //   3-consecutive (terminal): emit SessionEnd with
          //     stop_reason=MemoryDegraded per §8.3.1.
          // MemoryDegradationTracker.isDegraded() crosses the threshold
          // strictly after recordFailure() advances the counter.
          if (opts.memoryDegradation) opts.memoryDegradation.recordFailure();
          const failureCount = opts.memoryDegradation?.currentCount() ?? 1;
          const threshold = opts.memoryDegradation?.threshold ?? 3;

          if (opts.systemLog) {
            opts.systemLog.write({
              session_id: created.session_id,
              category: "MemoryDegraded",
              level: "warn",
              code: "memory-timeout",
              message:
                `Memory MCP searchMemories timed out (consecutive failure ` +
                `${failureCount}/${threshold}); continuing with stale slice`,
              data: {
                tool: err.tool,
                consecutive_failures: failureCount,
                threshold
              }
            });
          }

          if (opts.memoryDegradation?.isDegraded()) {
            // Threshold crossed — terminate the session per §8.3.1.
            opts.emitter.emit({
              session_id: created.session_id,
              type: "SessionEnd",
              payload: { stop_reason: "MemoryDegraded" }
            });
          }
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
