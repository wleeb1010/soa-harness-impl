import type { FastifyPluginAsync } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";

export const RUNNER_SUPPORTED_CORE_VERSIONS: readonly string[] = ["1.0"];
export const RUNNER_SOA_HARNESS_VERSION = "1.0";

/**
 * Intersect caller's `supported_core_versions` with the Runner's
 * supported set. Returns the highest common `A.B` tuple per §19.4.1
 * selection rule, or null when the intersection is empty.
 *
 * Comparison is by (major, minor) numeric tuple, not string order —
 * "1.10" sorts above "1.2" by tuple, contrary to string comparison.
 */
export function negotiateCoreVersion(
  callerSet: readonly string[],
  runnerSet: readonly string[] = RUNNER_SUPPORTED_CORE_VERSIONS
): string | null {
  const callerNorm = new Set(callerSet);
  const intersection: string[] = [];
  for (const v of runnerSet) {
    if (callerNorm.has(v)) intersection.push(v);
  }
  if (intersection.length === 0) return null;
  intersection.sort((a, b) => {
    const [am, an] = a.split(".").map((s) => parseInt(s, 10));
    const [bm, bn] = b.split(".").map((s) => parseInt(s, 10));
    if ((am ?? 0) !== (bm ?? 0)) return (bm ?? 0) - (am ?? 0);
    return (bn ?? 0) - (an ?? 0);
  });
  return intersection[0] ?? null;
}

/**
 * §19.4.1 wire-level version advertisement element: `supported_core_versions`
 * pattern `"^\\d+\\.\\d+$"` + minItems 1 + uniqueItems.
 */
export function parseSupportedCoreVersions(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "supported_core_versions must be a non-empty array of \"A.B\" strings" };
  }
  if (raw.length === 0) {
    return { error: "supported_core_versions must not be empty" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !/^\d+\.\d+$/.test(v)) {
      return {
        error: `supported_core_versions entries must match \"A.B\" pattern; got ${JSON.stringify(v)}`
      };
    }
    if (seen.has(v)) {
      return { error: `supported_core_versions contains duplicate entry ${JSON.stringify(v)}` };
    }
    seen.add(v);
    out.push(v);
  }
  return out;
}

export interface VersionPluginOptions {
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  supportedCoreVersions?: readonly string[];
  errataPath?: string;
  errataBody?: unknown;
}

export const versionPlugin: FastifyPluginAsync<VersionPluginOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const supported = opts.supportedCoreVersions ?? RUNNER_SUPPORTED_CORE_VERSIONS;

  app.get("/version", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }
    return reply.code(200).send({
      soaHarnessVersion: RUNNER_SOA_HARNESS_VERSION,
      supported_core_versions: [...supported],
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    });
  });

  const errataBody = opts.errataBody;
  if (errataBody !== undefined) {
    const errataPath = opts.errataPath ?? "/errata/v1.0.json";
    app.get(errataPath, async (_request, reply) => {
      reply.header("Cache-Control", "max-age=300");
      return reply.code(200).type("application/json; charset=utf-8").send(errataBody);
    });
  }
};
