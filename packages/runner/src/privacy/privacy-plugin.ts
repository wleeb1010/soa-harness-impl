import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { InMemorySessionStore } from "../permission/index.js";
import type { AuditChain } from "../audit/index.js";
import type { StreamEventEmitter } from "../stream/index.js";
import type { SystemLogBuffer } from "../system-log/index.js";
import type { InMemorySubjectStore, SubjectScope } from "./subject-store.js";
import { BOOT_SESSION_ID } from "../permission/boot-session.js";

/**
 * §10.7.1 privacy routes. Two first-class endpoints implementing the
 * `privacy.delete_subject` and `privacy.export_subject` MCP tool
 * semantics over HTTP transport (consistent with the rest of this
 * Runner's wire format).
 */

const VALID_SCOPES: ReadonlySet<SubjectScope> = new Set([
  "memory",
  "audit",
  "session",
  "all"
]);

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? (match[1] ?? null) : null;
}

export interface PrivacyRouteOptions {
  subjectStore: InMemorySubjectStore;
  sessionStore: InMemorySessionStore;
  chain: AuditChain;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  /**
   * Bootstrap bearer authorised for subject-admin operations.
   * Required for POST /privacy/delete_subject per §10.7.1 which is
   * operator-level, not session-level.
   */
  operatorBearer?: string;
  /** Stream emitter for audit-log side events. */
  emitter?: StreamEventEmitter;
  systemLog?: SystemLogBuffer;
  /** Boot session_id for system-log rows that aren't session-owned. */
  bootSessionId?: string;
}

interface DeleteRequestBody {
  subject_id?: unknown;
  scope?: unknown;
  legal_basis?: unknown;
  operator_kid?: unknown;
}

interface ExportRequestBody {
  subject_id?: unknown;
}

export const privacyPlugin: FastifyPluginAsync<PrivacyRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const bootSessionId = opts.bootSessionId ?? BOOT_SESSION_ID;

  app.post("/privacy/delete_subject", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    if (opts.operatorBearer !== undefined) {
      const bearer = extractBearer(request);
      if (bearer !== opts.operatorBearer) {
        return reply
          .code(401)
          .send({ error: "missing-or-invalid-operator-bearer" });
      }
    }

    const body = (request.body ?? {}) as DeleteRequestBody;
    const subject_id = body.subject_id;
    const scope = body.scope;
    const legal_basis = body.legal_basis;
    const operator_kid = body.operator_kid;

    if (typeof subject_id !== "string" || subject_id.length === 0) {
      return reply.code(400).send({
        error: "malformed-request",
        detail: "subject_id missing"
      });
    }
    if (typeof scope !== "string" || !VALID_SCOPES.has(scope as SubjectScope)) {
      return reply.code(400).send({
        error: "malformed-request",
        detail: `scope must be one of ${[...VALID_SCOPES].join(" | ")}`
      });
    }
    if (typeof legal_basis !== "string" || legal_basis.length === 0) {
      return reply.code(400).send({
        error: "malformed-request",
        detail: "legal_basis missing"
      });
    }
    if (typeof operator_kid !== "string" || operator_kid.length === 0) {
      return reply.code(400).send({
        error: "malformed-request",
        detail: "operator_kid missing"
      });
    }

    const now = opts.clock();
    const scopeList: SubjectScope[] =
      scope === "all" ? ["memory", "audit", "session"] : [scope as SubjectScope];
    const suppression = opts.subjectStore.tombstone({
      subject_id,
      scopes: scopeList,
      legal_basis,
      operator_kid,
      suppressed_at: now.toISOString()
    });

    // §10.5 WORM — append a SubjectSuppression audit record so the
    // tombstone itself is auditable. The chain's `decision` field is
    // SubjectSuppression (§24 closed enum entry).
    const appended = opts.chain.append({
      // audit row body — AuditChain handles hash chaining + subject_id
      // embed per §10.5.
      session_id: bootSessionId,
      decision: "SubjectSuppression",
      tool: "privacy.delete_subject",
      reason: `subject=${subject_id} scope=${scope} legal_basis=${legal_basis}`,
      subject_id,
      signer_key_id: operator_kid,
      timestamp: now.toISOString()
    });

    if (opts.systemLog) {
      opts.systemLog.write({
        session_id: bootSessionId,
        category: "ContextLoad",
        level: "info",
        code: "subject-suppressed",
        message: `SubjectSuppression recorded for subject=${subject_id} scope=${scope}`,
        data: {
          subject_id,
          scope,
          legal_basis,
          operator_kid,
          audit_record_hash: appended.this_hash
        }
      });
    }

    return reply.code(200).send({
      subject_id: suppression.subject_id,
      scope,
      legal_basis,
      operator_kid,
      suppressed_at: suppression.suppressed_at,
      audit_record_hash: appended.this_hash,
      runner_version: runnerVersion
    });
  });

  app.post("/privacy/export_subject", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    if (opts.operatorBearer !== undefined) {
      const bearer = extractBearer(request);
      if (bearer !== opts.operatorBearer) {
        return reply
          .code(401)
          .send({ error: "missing-or-invalid-operator-bearer" });
      }
    }

    const body = (request.body ?? {}) as ExportRequestBody;
    const subject_id = body.subject_id;
    if (typeof subject_id !== "string" || subject_id.length === 0) {
      return reply.code(400).send({
        error: "malformed-request",
        detail: "subject_id missing"
      });
    }

    const generated_at = opts.clock().toISOString();
    const exported = opts.subjectStore.export(subject_id, generated_at);
    return reply.code(200).send({ ...exported, runner_version: runnerVersion });
  });
};
