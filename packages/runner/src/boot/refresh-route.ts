/**
 * POST /crl/refresh — admin-only operator endpoint to force a CRL
 * refresh pass across all configured trust anchors.
 *
 * Why: the in-process scheduler (BootOrchestrator.refreshIntervalMs) handles
 * §7.3.1 CRL staleness in nominal conditions. This endpoint exists for two
 * scenarios:
 *   1. An operator sees a stale-CRL alert and wants to re-pull without
 *      restarting the Runner.
 *   2. A systemd timer (see docs/m7/deployment/systemd/soa-runner-crl-refresh.timer)
 *      wants to make the CRL freshness a belt-and-suspenders deployment
 *      concern rather than trusting only the in-process scheduler.
 *
 * Auth: admin-bearer only (same convention as other operator surfaces).
 * No session-bearer path — CRL refresh isn't a session-scoped concern.
 *
 * Response: 200 with a summary of how many anchors were refreshed and
 * whether any failed. Failures don't fail the HTTP call — the refresh
 * routine records them via onRefreshError and keeps going. Caller
 * inspects the response body to decide next steps.
 */

import type { FastifyPluginAsync } from "fastify";
import type { Clock } from "../clock/index.js";
import type { BootOrchestrator } from "./orchestrator.js";

export interface CrlRefreshRouteOptions {
  orchestrator: BootOrchestrator;
  bootstrapBearer: string;
  clock: Clock;
  runnerVersion?: string;
}

export const crlRefreshPlugin: FastifyPluginAsync<CrlRefreshRouteOptions> = async (app, opts) => {
  const runnerVersion = opts.runnerVersion ?? "1.1";

  app.post("/crl/refresh", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const hdr = request.headers["authorization"];
    const match = typeof hdr === "string" ? /^Bearer\s+(.+)$/.exec(hdr.trim()) : null;
    const bearer = match ? match[1] : null;
    if (bearer !== opts.bootstrapBearer) {
      return reply.code(403).send({ error: "admin-only" });
    }

    const startedAt = opts.clock().toISOString();
    let ok = true;
    let err: string | null = null;
    try {
      await opts.orchestrator.refreshAllNow();
    } catch (e) {
      ok = false;
      err = e instanceof Error ? e.message : String(e);
    }
    const completedAt = opts.clock().toISOString();

    return reply.code(200).send({
      refreshed: ok,
      error: err,
      runner_version: runnerVersion,
      started_at: startedAt,
      completed_at: completedAt,
    });
  });
};
