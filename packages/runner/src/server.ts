import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { InitialTrust } from "./bootstrap/index.js";
import { cardPlugin, type JwsAlg, type PrivateKeyLike } from "./card/index.js";
import { probesPlugin, type ReadinessProbe } from "./probes/index.js";
import {
  permissionsResolvePlugin,
  type PermissionsResolveRouteOptions,
  type SessionStore
} from "./permission/index.js";
import type { ToolRegistry } from "./registry/index.js";
import type { Capability } from "./permission/index.js";
import type { Control } from "./registry/index.js";
import type { Clock } from "./clock/index.js";

export interface BuildRunnerOptions {
  trust: InitialTrust;
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
  x5c: string[];
  /** Readiness aggregator. Default: alwaysReady. Real checks wire in per component as they land. */
  readiness?: ReadinessProbe;
  /**
   * Optional — when present, the Runner exposes GET /permissions/resolve per
   * Core §10.3.1. Omit the whole block to disable the endpoint (early-
   * milestone deployments that don't yet expose the observability surface).
   */
  permissionsResolve?: {
    registry: ToolRegistry;
    sessionStore: SessionStore;
    clock: Clock;
    activeCapability: Capability;
    toolRequirements?: Record<string, Control>;
    policyEndpoint?: string;
    runnerVersion?: string;
    requestsPerMinute?: number;
  };
  fastifyOptions?: FastifyServerOptions;
}

export async function buildRunnerApp(opts: BuildRunnerOptions): Promise<FastifyInstance> {
  const app = fastify(opts.fastifyOptions ?? {});

  await app.register(cardPlugin, {
    card: opts.card,
    alg: opts.alg,
    kid: opts.kid,
    privateKey: opts.privateKey,
    x5c: opts.x5c
  });

  const readiness = opts.readiness;
  await app.register(probesPlugin, readiness ? { readiness } : {});

  if (opts.permissionsResolve !== undefined) {
    const pr = opts.permissionsResolve;
    const routeOpts: PermissionsResolveRouteOptions = {
      registry: pr.registry,
      sessionStore: pr.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: pr.clock,
      activeCapability: pr.activeCapability,
      ...(pr.toolRequirements !== undefined ? { toolRequirements: pr.toolRequirements } : {}),
      ...(pr.policyEndpoint !== undefined ? { policyEndpoint: pr.policyEndpoint } : {}),
      ...(pr.runnerVersion !== undefined ? { runnerVersion: pr.runnerVersion } : {}),
      ...(pr.requestsPerMinute !== undefined ? { requestsPerMinute: pr.requestsPerMinute } : {})
    };
    await app.register(permissionsResolvePlugin, routeOpts);
  }

  return app;
}

export interface StartRunnerOptions extends BuildRunnerOptions {
  host?: string;
  port?: number;
  tls?: {
    key: Buffer | string;
    cert: Buffer | string;
  };
}

export async function startRunner(opts: StartRunnerOptions): Promise<FastifyInstance> {
  const fastifyOptions: FastifyServerOptions = opts.fastifyOptions ?? {};
  if (opts.tls) {
    (fastifyOptions as FastifyServerOptions & { https: unknown }).https = {
      key: opts.tls.key,
      cert: opts.tls.cert,
      minVersion: "TLSv1.3"
    };
  }
  const app = await buildRunnerApp({ ...opts, fastifyOptions });
  await app.listen({ host: opts.host ?? "0.0.0.0", port: opts.port ?? 7700 });
  return app;
}
