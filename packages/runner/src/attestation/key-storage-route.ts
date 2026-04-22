/**
 * §10.6.4 L-48 Finding BH — GET /security/key-storage.
 *
 * Operator-bearer OR admin:read, 60 rpm, not-a-side-effect. Reports
 * storage metadata so validators can prove the negative
 * `private_keys_on_disk === false` without filesystem inspection.
 *
 * Conformance: production Runners MUST report storage_mode ∈
 * {hsm, software-keystore}. `ephemeral` is test-only.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";

export type KeyStorageMode = "hsm" | "software-keystore" | "ephemeral";

export interface KeyStorageReport {
  storage_mode: KeyStorageMode;
  private_keys_on_disk: boolean;
  provider?: string;
  attestation_format?: string;
}

export interface KeyStorageRouteOptions {
  report: KeyStorageReport;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  /** Operator bearer — authorizes alongside admin:read. */
  operatorBearer?: string;
}

const WINDOW_MS = 60_000;

class PerBearerLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: Clock) {}
  consume(hash: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    const fresh = (this.windows.get(hash) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      this.windows.set(hash, fresh);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000))
      };
    }
    fresh.push(t);
    this.windows.set(hash, fresh);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const hdr = request.headers["authorization"];
  if (typeof hdr !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(hdr.trim());
  return match ? match[1] ?? null : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function bearerAuthorized(
  store: SessionStore,
  operatorBearer: string | undefined,
  bearer: string
): boolean {
  if (operatorBearer !== undefined && bearer === operatorBearer) return true;
  // admin:read surfaces (session bearers) also accepted — matches §14.5.3 / §10.5.3 convention.
  const maybe = (store as unknown as { anySession?: (b: string) => boolean }).anySession;
  return typeof maybe === "function" ? maybe.call(store, bearer) : false;
}

export const keyStoragePlugin: FastifyPluginAsync<KeyStorageRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);

  app.get("/security/key-storage", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });
    if (!bearerAuthorized(opts.sessionStore, opts.operatorBearer, bearer)) {
      return reply.code(403).send({ error: "bearer-lacks-admin-read-scope" });
    }

    const rl = limiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const body: Record<string, unknown> = {
      storage_mode: opts.report.storage_mode,
      private_keys_on_disk: opts.report.private_keys_on_disk,
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };
    if (opts.report.provider !== undefined) body["provider"] = opts.report.provider;
    if (opts.report.attestation_format !== undefined) {
      body["attestation_format"] = opts.report.attestation_format;
    }
    return reply.code(200).send(body);
  });
};
