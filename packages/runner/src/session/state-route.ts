/**
 * §12.5.1 — GET /sessions/<session_id>/state observability endpoint.
 *
 * Not-a-side-effect: no audit write, no workflow advance, no StreamEvent,
 * no session-file mutation. Body reflects persisted state so the response
 * matches what a crash-and-restart would observe.
 *
 * Byte-identity contract: two reads of a quiescent session MUST be byte-
 * equal when `generated_at` is excluded from the comparison. This
 * implementation builds the response body from fields extracted from the
 * on-disk PersistedSession in a fixed key order, then adds `runner_version`
 * + `generated_at` last. JSON.stringify preserves insertion order for
 * string keys on V8, so two successive calls emit the same bytes except
 * for `generated_at`.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import type { ReadinessProbe } from "../probes/index.js";
import type { Clock } from "../clock/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { PersistedSession } from "./migrate.js";
import { SessionPersister, SessionFormatIncompatible } from "./persist.js";
import { resumeSession, CardVersionDrift, type ResumeContext } from "./resume.js";
import { ToolPoolStale } from "../registry/index.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{16,}$/;
const WINDOW_MS = 60_000;

/**
 * L-29 lazy-hydrate helper. Returns true when the session was registered
 * from disk, false when the file doesn't exist (→ caller 404s).
 * A corrupted/bad-format file propagates the underlying error — the caller's
 * main try/catch surfaces it as 500 persisted-state-incompatible.
 */
async function tryLazyHydrate(
  opts: SessionStateRouteOptions,
  sessionId: string,
  bearer: string
): Promise<boolean | { rejected: true; status: number; body: Record<string, unknown> }> {
  let persisted: PersistedSession;
  try {
    // §12.5 L-29 trigger #2: when a resumeCtx is wired, drive the full
    // resume algorithm rather than a raw read. This catches CardVersionDrift
    // at the /state entrypoint for a Phase-A session persisted under card
    // v1.0 being opened by a process serving card v1.1.
    if (opts.resumeCtx) {
      try {
        const outcome = await resumeSession(opts.persister, sessionId, opts.resumeCtx);
        persisted = outcome.session;
      } catch (err) {
        if (err instanceof SessionFormatIncompatible && err.reason === "file-missing") {
          return false;
        }
        if (err instanceof CardVersionDrift) {
          return {
            rejected: true,
            status: 409,
            body: {
              error: "card-version-drift",
              expected: err.expected,
              actual: err.actual
            }
          };
        }
        if (err instanceof ToolPoolStale) {
          return {
            rejected: true,
            status: 409,
            body: { error: "tool-pool-stale", reason: err.reason }
          };
        }
        throw err;
      }
    } else {
      persisted = await opts.persister.readSession(sessionId);
    }
  } catch (err) {
    if (err instanceof SessionFormatIncompatible && err.reason === "file-missing") {
      return false;
    }
    throw err;
  }
  // Register the session with the sessionStore so subsequent validate() calls
  // pass. The InMemorySessionStore's register() signature is cached-only —
  // narrow the ts-expect-error surface by asserting the shape we need here.
  const store = opts.sessionStore as unknown as {
    register: (
      session_id: string,
      bearer: string,
      opts?: {
        activeMode?: "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
        user_sub?: string;
        canDecide?: boolean;
      }
    ) => void;
  };
  if (typeof store.register !== "function") {
    // A non-InMemorySessionStore impl (future stores) MAY not support
    // on-demand registration. Fail closed to 404 — operator's store
    // SHOULD be pre-populated via boot scan instead.
    return false;
  }
  store.register(sessionId, bearer, {
    activeMode: persisted.activeMode as "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess",
    user_sub: "lazy-hydrated",
    canDecide: false
  });
  return true;
}

export interface SessionStateRouteOptions {
  persister: SessionPersister;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /** Requests per 60-second window per bearer. §12.5.1 requires 120. */
  requestsPerMinute?: number;
  /**
   * L-29 Normative MUST #2 — when present, lazy-hydrate drives the full
   * §12.5 resume algorithm (card_version + tool_pool_hash checks + phase
   * replay) rather than a raw readSession. A CardVersionDrift during
   * lazy-hydrate surfaces as 409 card-version-drift with the expected +
   * actual versions so the client can re-bootstrap cleanly. Absent →
   * lazy-hydrate falls back to readSession (test/M2 back-compat).
   */
  resumeCtx?: ResumeContext;
}

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

interface SideEffectResponseItem {
  tool: string;
  idempotency_key: string;
  phase: "pending" | "inflight" | "committed" | "compensated";
  args_digest: string;
  result_digest?: string | null;
  first_attempted_at: string;
  last_phase_transition_at: string;
}

interface SessionStateResponseBody {
  session_id: string;
  format_version: "1.0";
  activeMode: "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
  created_at?: string;
  last_significant_event_at?: string;
  workflow: {
    task_id: string;
    status: string;
    side_effects: SideEffectResponseItem[];
    checkpoint?: Record<string, unknown>;
  };
  counters: Record<string, unknown>;
  tool_pool_hash: string;
  card_version: string;
  runner_version: string;
  generated_at: string;
}

/**
 * Build a response body whose key order is fixed per the schema. Missing
 * required-by-response fields on the persisted side_effect entries trigger
 * a loud internal error — the server refuses to emit a schema-violating body.
 */
function buildResponseBody(
  persisted: PersistedSession,
  runnerVersion: string,
  generatedAt: string
): SessionStateResponseBody {
  const workflow = persisted.workflow as
    | undefined
    | {
        task_id?: string;
        status?: string;
        side_effects?: Array<Record<string, unknown>>;
        checkpoint?: Record<string, unknown>;
      };

  if (!workflow || typeof workflow !== "object") {
    throw new InternalPersistedStateError("workflow-missing", persisted.session_id);
  }

  const sideEffects = Array.isArray(workflow.side_effects) ? workflow.side_effects : [];
  const mappedSideEffects: SideEffectResponseItem[] = sideEffects.map((se, idx) => {
    const tool = typeof se["tool"] === "string" ? (se["tool"] as string) : undefined;
    const idempotency_key =
      typeof se["idempotency_key"] === "string" ? (se["idempotency_key"] as string) : undefined;
    const phase = typeof se["phase"] === "string" ? (se["phase"] as string) : undefined;
    const args_digest = typeof se["args_digest"] === "string" ? (se["args_digest"] as string) : undefined;
    const first_attempted_at =
      typeof se["first_attempted_at"] === "string" ? (se["first_attempted_at"] as string) : undefined;
    const last_phase_transition_at =
      typeof se["last_phase_transition_at"] === "string"
        ? (se["last_phase_transition_at"] as string)
        : undefined;

    if (
      !tool ||
      !idempotency_key ||
      !phase ||
      !args_digest ||
      !first_attempted_at ||
      !last_phase_transition_at
    ) {
      throw new InternalPersistedStateError(
        `side-effect[${idx}]-missing-required-field`,
        persisted.session_id
      );
    }
    if (!["pending", "inflight", "committed", "compensated"].includes(phase)) {
      throw new InternalPersistedStateError(
        `side-effect[${idx}]-unknown-phase=${phase}`,
        persisted.session_id
      );
    }

    const item: SideEffectResponseItem = {
      tool,
      idempotency_key,
      phase: phase as SideEffectResponseItem["phase"],
      args_digest,
      first_attempted_at,
      last_phase_transition_at
    };
    if (se["result_digest"] === null || typeof se["result_digest"] === "string") {
      item.result_digest = se["result_digest"] as string | null;
    }
    return item;
  });

  const counters =
    persisted.counters && typeof persisted.counters === "object" && !Array.isArray(persisted.counters)
      ? (persisted.counters as Record<string, unknown>)
      : {};

  const body: SessionStateResponseBody = {
    session_id: persisted.session_id,
    format_version: "1.0",
    activeMode: persisted.activeMode as SessionStateResponseBody["activeMode"],
    ...(typeof persisted["created_at"] === "string" ? { created_at: persisted["created_at"] } : {}),
    ...(typeof persisted["last_significant_event_at"] === "string"
      ? { last_significant_event_at: persisted["last_significant_event_at"] as string }
      : {}),
    workflow: {
      task_id: workflow.task_id ?? "",
      status: workflow.status ?? "Planning",
      side_effects: mappedSideEffects,
      ...(workflow.checkpoint !== undefined ? { checkpoint: workflow.checkpoint } : {})
    },
    counters,
    tool_pool_hash: persisted.tool_pool_hash ?? "",
    card_version: persisted.card_version ?? "",
    runner_version: runnerVersion,
    generated_at: generatedAt
  };

  return body;
}

/** Internal — propagates an on-disk inconsistency to a 500-class response. */
class InternalPersistedStateError extends Error {
  constructor(
    public readonly reason: string,
    public readonly sessionId: string
  ) {
    super(`persisted state inconsistency session=${sessionId} reason=${reason}`);
    this.name = "InternalPersistedStateError";
  }
}

export const sessionStatePlugin: FastifyPluginAsync<SessionStateRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new BearerRateLimiter(opts.requestsPerMinute ?? 120, opts.clock);
  const responseValidator = schemaRegistry["session-state-response"];

  app.get<{ Params: { session_id: string } }>(
    "/sessions/:session_id/state",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");

      // Readiness gate first — pre-boot requests never touch auth or persistence.
      const notReady = opts.readiness.check();
      if (notReady !== null) {
        return reply.code(503).send({ status: "not-ready", reason: notReady });
      }

      const bearer = extractBearer(request);
      if (!bearer) {
        return reply.code(401).send({ error: "missing-or-invalid-bearer" });
      }
      const bearerHash = sha256Hex(bearer);

      const rl = limiter.consume(bearerHash);
      if (!rl.allowed) {
        reply.header("Retry-After", String(rl.retryAfterSeconds));
        return reply.code(429).send({ error: "rate-limit-exceeded" });
      }

      const { session_id: sessionId } = request.params;
      if (!SESSION_ID_RE.test(sessionId)) {
        return reply.code(400).send({ error: "malformed-session-id" });
      }

      // sessions:read:<session_id> is default-granted on §12.6 session bootstrap.
      // The bearer must validate against THIS session_id specifically — cross-
      // session reads are forbidden (scope is per-session_id).
      //
      // L-29 Normative MUST #2 — lazy-hydrate: if the session isn't in the
      // in-memory store but a matching on-disk file exists, the endpoint
      // auto-hydrates before serving. This handles the client-reconnect-
      // after-runner-restart case without forcing operators to re-bootstrap
      // every session. First-bearer-wins: the bearer presented on the
      // hydrating call becomes the canonical bearer for the session in
      // this process. Subsequent requests with a different bearer → 403.
      if (!opts.sessionStore.exists(sessionId)) {
        const hydrated = await tryLazyHydrate(opts, sessionId, bearer);
        if (hydrated === false) {
          return reply.code(404).send({ error: "unknown-session" });
        }
        if (hydrated !== true && typeof hydrated === "object" && "rejected" in hydrated) {
          return reply.code(hydrated.status).send(hydrated.body);
        }
      }
      if (!opts.sessionStore.validate(sessionId, bearer)) {
        return reply.code(403).send({ error: "session-bearer-mismatch" });
      }

      let persisted: PersistedSession;
      try {
        persisted = await opts.persister.readSession(sessionId);
      } catch (err) {
        if (err instanceof SessionFormatIncompatible) {
          if (err.reason === "file-missing") {
            return reply.code(404).send({ error: "unknown-session" });
          }
          // Other reasons (corrupted/partial/schema-violation/bad-format) —
          // the persisted state is unusable. The endpoint declines to serve
          // a response the validator cannot trust. 500 with a specific tag
          // lets operators distinguish this from a general server error.
          return reply.code(500).send({ error: "persisted-state-incompatible", reason: err.reason });
        }
        throw err;
      }

      const generatedAt = opts.clock().toISOString();
      let body: SessionStateResponseBody;
      try {
        body = buildResponseBody(persisted, runnerVersion, generatedAt);
      } catch (err) {
        if (err instanceof InternalPersistedStateError) {
          return reply
            .code(500)
            .send({ error: "persisted-state-incompatible", reason: err.reason });
        }
        throw err;
      }

      // Guardrail: validate the outgoing body against the pinned response schema.
      // A violation is a server-side bug, not a client problem — 500 so a
      // conformance test catches it immediately.
      if (!responseValidator(body)) {
        return reply.code(500).send({
          error: "response-schema-violation",
          detail: JSON.stringify(responseValidator.errors ?? [])
        });
      }

      return reply.code(200).send(body);
    }
  );
};
