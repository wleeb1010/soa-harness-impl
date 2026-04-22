/**
 * §10.6.3 L-48 Finding BG — POST /handlers/enroll.
 *
 * Operator-bearer endpoint enrolling a new handler kid into the
 * HandlerKeyRegistry. Per §10.6:
 *
 *   - kid uniqueness enforced → 409 HandlerKidConflict on duplicate.
 *   - algo ∈ {EdDSA, ES256, RS3072, RS4096} → 400 AlgorithmRejected
 *     otherwise (RS256 + RSA<3072 explicitly forbidden).
 *
 * The spki is accepted as opaque base64url DER; we keep it on the
 * registry entry so future verify-time lookups have the bytes. The
 * conformance handler's ephemeral key is still resolved via
 * resolvePdaVerifyKey — this endpoint is additive.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ReadinessProbe } from "../probes/index.js";
import {
  AlgorithmRejected,
  HandlerKidConflict,
  HandlerKeyRegistry,
  isHandlerAlgo
} from "./handler-key.js";

export interface HandlerEnrollRouteOptions {
  registry: HandlerKeyRegistry;
  readiness: ReadinessProbe;
  runnerVersion?: string;
  operatorBearer?: string;
}

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? match[1] ?? null : null;
}

export const handlerEnrollPlugin: FastifyPluginAsync<HandlerEnrollRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";

  app.post("/handlers/enroll", async (request, reply) => {
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
    const kid = body["kid"];
    const spki = body["spki"];
    const algo = body["algo"];
    const issuedAt = body["issued_at"];
    if (
      typeof kid !== "string" ||
      kid.length === 0 ||
      typeof spki !== "string" ||
      spki.length === 0 ||
      typeof algo !== "string" ||
      typeof issuedAt !== "string"
    ) {
      return reply.code(400).send({ error: "malformed-body" });
    }

    if (!isHandlerAlgo(algo)) {
      return reply.code(400).send({
        error: "AlgorithmRejected",
        detail:
          `algo="${algo}" not in §10.6 accepted set {EdDSA, ES256, RS3072, RS4096}`
      });
    }

    try {
      opts.registry.enroll({
        kid,
        spki_hex: spki,
        algo,
        enrolled_at: issuedAt
      });
    } catch (err) {
      if (err instanceof HandlerKidConflict) {
        return reply.code(409).send({
          error: "HandlerKidConflict",
          detail: `kid "${kid}" already enrolled`
        });
      }
      if (err instanceof AlgorithmRejected) {
        // defensive — isHandlerAlgo already filtered above
        return reply.code(400).send({
          error: "AlgorithmRejected",
          detail: err.message
        });
      }
      throw err;
    }

    return reply.code(201).send({
      enrolled: true,
      kid,
      issued_at: issuedAt,
      runner_version: runnerVersion
    });
  });
};
