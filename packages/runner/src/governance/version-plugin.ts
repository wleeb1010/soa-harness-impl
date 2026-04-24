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

/**
 * Doc-route entry. The Runner loads each body at boot and serves it
 * on `route` with the supplied Content-Type. Bodies MUST be small
 * deployment-bundled artifacts (docs, release-gate.json) — not
 * user content. Serving reads a cached Buffer; no per-request disk IO.
 */
export interface DocRoute {
  route: string;
  body: string | Buffer;
  contentType: string;
  cacheControl?: string;
}

export interface VersionPluginOptions {
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  supportedCoreVersions?: readonly string[];
  errataPath?: string;
  errataBody?: unknown;
  /**
   * L-62 — pinned spec commit SHA baked in at build time via
   * @soa-harness/schemas PINNED_SPEC_COMMIT. Exposed at /version so
   * validators can check pin alignment via `soa-validate --check-pins`.
   */
  pinnedSpecCommit?: string;
  /**
   * Finding AF — HTTP doc routes. Each entry wires a GET route that
   * returns the pre-loaded body with the declared Content-Type. Keeps
   * the validator from needing filesystem access to probe docs + the
   * release gate.
   */
  docRoutes?: readonly DocRoute[];
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
    const body: Record<string, unknown> = {
      soaHarnessVersion: RUNNER_SOA_HARNESS_VERSION,
      supported_core_versions: [...supported],
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (opts.pinnedSpecCommit !== undefined) {
      body["spec_commit_sha"] = opts.pinnedSpecCommit;
    }
    return reply.code(200).send(body);
  });

  const errataBody = opts.errataBody;
  if (errataBody !== undefined) {
    const errataPath = opts.errataPath ?? "/errata/v1.0.json";
    app.get(errataPath, async (_request, reply) => {
      reply.header("Cache-Control", "max-age=300");
      return reply.code(200).type("application/json; charset=utf-8").send(errataBody);
    });
  }

  for (const doc of opts.docRoutes ?? []) {
    app.get(doc.route, async (_request, reply) => {
      reply.header("Cache-Control", doc.cacheControl ?? "max-age=300");
      return reply.code(200).type(doc.contentType).send(doc.body);
    });
  }
};
