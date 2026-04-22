/**
 * §11.4 GET /tools/registered — scaffold stub (M3-T3).
 *
 * Returns the currently-registered global Tool Registry state. For M3-T3
 * this is the static-fixture registry only; dynamic MCP registration
 * (§11.2) wires in with T-5 in Week 2.
 *
 * `registry_version = sha256(JCS(tools[]))` per §11.4 — stable within a
 * static-fixture deployment; changes whenever the registry is modified
 * (dynamic-add in T-5 updates this).
 *
 * Auth + rate-limit mirror /audit/records: any session bearer, 60 rpm.
 * L-28 F-01 byte-identity rule applies — `generated_at` excluded.
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { jcs } from "@soa-harness/core";
import type { Clock } from "../clock/index.js";
import type { ReadinessProbe } from "../probes/index.js";
import type { SessionStore } from "../permission/session-store.js";
import type { ToolRegistry } from "../registry/index.js";

const WINDOW_MS = 60_000;

/**
 * Schema's `risk_class` enum is {ReadOnly, Mutating, Destructive} — no
 * `Egress`. Map the registry's value to the schema's: Egress normalizes
 * to Mutating (it's the nearest fit per §11 mutation semantics).
 */
function toSchemaRiskClass(rc: string): "ReadOnly" | "Mutating" | "Destructive" {
  if (rc === "ReadOnly" || rc === "Mutating" || rc === "Destructive") return rc;
  return "Mutating"; // Egress → Mutating
}

export interface ToolsRegisteredRouteOptions {
  registry: ToolRegistry;
  sessionStore: SessionStore;
  readiness: ReadinessProbe;
  clock: Clock;
  runnerVersion?: string;
  requestsPerMinute?: number;
  /**
   * Per-tool registration timestamp. When omitted, the route uses the
   * Runner's boot time as the default registered_at for every tool in
   * the static fixture. T-5 replaces this with per-tool timestamps as
   * dynamic MCP registrations land.
   */
  registeredAt?: Date;
}

class PerBearerLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: Clock) {}

  consume(bearerHash: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now().getTime();
    const fresh = (this.windows.get(bearerHash) ?? []).filter((ts) => t - ts < WINDOW_MS);
    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      this.windows.set(bearerHash, fresh);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (t - oldest)) / 1000))
      };
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

function bearerAuthorizedForAuditRead(store: SessionStore, bearer: string): boolean {
  const maybe = (store as unknown as { anySession?: (b: string) => boolean }).anySession;
  return typeof maybe === "function" ? maybe.call(store, bearer) : false;
}

function computeRegistryVersion(tools: Array<Record<string, unknown>>): string {
  const canonical = jcs(tools as unknown);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export const toolsRegisteredPlugin: FastifyPluginAsync<ToolsRegisteredRouteOptions> = async (
  app,
  opts
) => {
  const runnerVersion = opts.runnerVersion ?? "1.0";
  const limiter = new PerBearerLimiter(opts.requestsPerMinute ?? 60, opts.clock);
  const responseValidator = schemaRegistry["tools-registered-response"];
  const registeredAt = (opts.registeredAt ?? opts.clock()).toISOString();

  app.get("/tools/registered", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    const notReady = opts.readiness.check();
    if (notReady !== null) {
      return reply.code(503).send({ status: "not-ready", reason: notReady });
    }

    const bearer = extractBearer(request);
    if (!bearer) return reply.code(401).send({ error: "missing-or-invalid-bearer" });
    if (!bearerAuthorizedForAuditRead(opts.sessionStore, bearer)) {
      return reply.code(403).send({ error: "bearer-lacks-audit-read-scope" });
    }
    const rl = limiter.consume(sha256Hex(bearer));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      return reply.code(429).send({ error: "rate-limit-exceeded" });
    }

    const entries = opts.registry.names().map((name) => {
      const tool = opts.registry.mustLookup(name);
      const row: Record<string, unknown> = {
        name: tool.name,
        risk_class: toSchemaRiskClass(tool.risk_class),
        default_control: tool.default_control,
        registered_at: tool._registered_at ?? registeredAt,
        registration_source: tool._registration_source ?? ("static-fixture" as const)
      };
      if (typeof tool.idempotency_retention_seconds === "number") {
        row["idempotency_retention_seconds"] = tool.idempotency_retention_seconds;
      }
      return row;
    });

    const body = {
      tools: entries,
      registry_version: computeRegistryVersion(entries),
      runner_version: runnerVersion,
      generated_at: opts.clock().toISOString()
    };

    if (!responseValidator(body)) {
      return reply.code(500).send({
        error: "response-schema-violation",
        detail: JSON.stringify(responseValidator.errors ?? [])
      });
    }

    return reply.code(200).send(body);
  });
};
