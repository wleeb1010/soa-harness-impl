import type { FastifyPluginAsync } from "fastify";
import { alwaysReady, type ReadinessProbe } from "./types.js";

export interface ProbesPluginOptions {
  /** Readiness probe. Defaults to `alwaysReady` — production deployments pass a real aggregator. */
  readiness?: ReadinessProbe;
  /** Route override for /health. */
  healthPath?: string;
  /** Route override for /ready. */
  readyPath?: string;
}

const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_READY_PATH = "/ready";
const SOA_HARNESS_VERSION = "1.0";

export const probesPlugin: FastifyPluginAsync<ProbesPluginOptions> = async (app, opts) => {
  const readiness = opts.readiness ?? alwaysReady;
  const healthPath = opts.healthPath ?? DEFAULT_HEALTH_PATH;
  const readyPath = opts.readyPath ?? DEFAULT_READY_PATH;

  // §5.4 line 200: /health MUST remain reachable even under rate-limit saturation and MUST NOT
  // expose session / audit data. Body is fixed; authentication is NOT required.
  app.get(healthPath, async (_request, reply) => {
    reply.code(200).header("Cache-Control", "no-store");
    return { status: "alive", soaHarnessVersion: SOA_HARNESS_VERSION };
  });

  // §5.4 line 207: /ready returns 200 {"status":"ready"} only when all gates pass, else
  // 503 {"status":"not-ready","reason":"<enum>"}. Reason is a closed set.
  app.get(readyPath, async (_request, reply) => {
    const reason = readiness.check();
    if (reason !== null) {
      reply.code(503).header("Cache-Control", "no-store");
      return { status: "not-ready", reason };
    }
    reply.code(200).header("Cache-Control", "no-store");
    return { status: "ready" };
  });
};
