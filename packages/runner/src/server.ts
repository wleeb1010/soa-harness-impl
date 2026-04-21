import { fastify, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { InitialTrust } from "./bootstrap/index.js";
import { cardPlugin, type JwsAlg, type PrivateKeyLike } from "./card/index.js";
import { probesPlugin, type ReadinessProbe } from "./probes/index.js";
import {
  permissionsResolvePlugin,
  sessionsBootstrapPlugin,
  permissionsDecisionsPlugin,
  type PermissionsResolveRouteOptions,
  type PermissionsDecisionsRouteOptions,
  type SessionStore,
  InMemorySessionStore
} from "./permission/index.js";
import type { HandlerKeyResolver, KidRevokedCheck } from "./attestation/index.js";
import type { ToolRegistry } from "./registry/index.js";
import type { Capability } from "./permission/index.js";
import type { Control } from "./registry/index.js";
import type { Clock } from "./clock/index.js";
import {
  AuditChain,
  auditTailPlugin,
  auditRecordsPlugin,
  auditSinkEventsPlugin,
  AuditSink
} from "./audit/index.js";
import { sessionStatePlugin, SessionPersister } from "./session/index.js";
import { budgetProjectionPlugin, toolsRegisteredPlugin } from "./observability/index.js";

export interface BuildRunnerOptions {
  trust: InitialTrust;
  card: unknown;
  alg: JwsAlg;
  kid: string;
  privateKey: PrivateKeyLike;
  x5c: string[];
  /** When true, cardPlugin skips boot-time agent-card schema validation — used for pinned conformance fixtures. */
  skipCardSchemaValidation?: boolean;
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
  /**
   * Optional — when present the Runner exposes POST /sessions per Core §12.6.
   * Requires a bootstrap bearer (from env in production) and an
   * InMemorySessionStore.
   */
  sessionsBootstrap?: {
    sessionStore: InMemorySessionStore;
    clock: Clock;
    cardActiveMode: Capability;
    bootstrapBearer: string;
    defaultTtlSeconds?: number;
    maxTtlSeconds?: number;
    runnerVersion?: string;
    requestsPerMinute?: number;
    /** §12.6 MUST — session file is persisted before POST /sessions 201. */
    persister?: SessionPersister;
    toolPoolHash?: string;
    cardVersion?: string;
  };
  /**
   * Optional — when present the Runner exposes GET /audit/tail per Core §10.5.2.
   */
  auditTail?: {
    chain: AuditChain;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
  };
  /**
   * Optional — when present the Runner exposes GET /audit/records per Core
   * §10.5.3 with pagination. Shares the AuditChain with auditTail.
   */
  auditRecords?: {
    chain: AuditChain;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultLimit?: number;
    maxLimit?: number;
  };
  /**
   * Optional — when present the Runner exposes POST /permissions/decisions
   * per Core §10.3.2. Requires a ToolRegistry, an AuditChain (shared with
   * auditTail for a consistent view of the hash chain), and a SessionStore.
   * resolvePdaVerifyKey is optional; omit when no PDA handler keys are enrolled
   * (all PDA submissions will coerce to Deny per §10.3.2).
   */
  permissionsDecisions?: {
    registry: ToolRegistry;
    sessionStore: SessionStore;
    chain: AuditChain;
    clock: Clock;
    activeCapability: Capability;
    toolRequirements?: Record<string, Control>;
    policyEndpoint?: string;
    resolvePdaVerifyKey?: HandlerKeyResolver;
    isPdaKidRevoked?: KidRevokedCheck;
    runnerVersion?: string;
    requestsPerMinute?: number;
    sink?: AuditSink;
    /** §12.2 L-31 bracket-persist bundle — all four required together. */
    persister?: SessionPersister;
    markers?: import("./markers/index.js").MarkerEmitter;
    toolPoolHash?: string;
    cardVersion?: string;
  };
  /**
   * Optional — when present the Runner exposes GET /audit/sink-events
   * per Core §12.5.4. Shares the AuditSink instance with
   * permissionsDecisions so state transitions produced by the decision
   * path are observable on the channel.
   */
  auditSinkEvents?: {
    sink: AuditSink;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultLimit?: number;
    maxLimit?: number;
  };
  /**
   * Optional — when present the Runner exposes GET /sessions/<session_id>/state
   * per Core §12.5.1. Requires a SessionPersister (reads persisted session
   * state from disk) and a SessionStore (bearer auth).
   */
  sessionState?: {
    persister: SessionPersister;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    /** L-29 lazy-hydrate calls resume_session when present. */
    resumeCtx?: import("./session/resume.js").ResumeContext;
  };
  /** M3-T3 scaffold: GET /budget/projection (§13.5) — placeholder body. */
  budgetProjection?: {
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultMaxTokensPerRun?: number;
  };
  /** M3-T3 scaffold: GET /tools/registered (§11.4) — static-fixture only. */
  toolsRegistered?: {
    registry: ToolRegistry;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    registeredAt?: Date;
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
    x5c: opts.x5c,
    ...(opts.skipCardSchemaValidation ? { skipSchemaValidation: true } : {})
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

  if (opts.sessionsBootstrap !== undefined) {
    const sb = opts.sessionsBootstrap;
    await app.register(sessionsBootstrapPlugin, {
      sessionStore: sb.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: sb.clock,
      cardActiveMode: sb.cardActiveMode,
      bootstrapBearer: sb.bootstrapBearer,
      ...(sb.defaultTtlSeconds !== undefined ? { defaultTtlSeconds: sb.defaultTtlSeconds } : {}),
      ...(sb.maxTtlSeconds !== undefined ? { maxTtlSeconds: sb.maxTtlSeconds } : {}),
      ...(sb.runnerVersion !== undefined ? { runnerVersion: sb.runnerVersion } : {}),
      ...(sb.requestsPerMinute !== undefined ? { requestsPerMinute: sb.requestsPerMinute } : {}),
      ...(sb.persister !== undefined ? { persister: sb.persister } : {}),
      ...(sb.toolPoolHash !== undefined ? { toolPoolHash: sb.toolPoolHash } : {}),
      ...(sb.cardVersion !== undefined ? { cardVersion: sb.cardVersion } : {})
    });
  }

  if (opts.auditTail !== undefined) {
    const at = opts.auditTail;
    await app.register(auditTailPlugin, {
      chain: at.chain,
      sessionStore: at.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: at.clock,
      ...(at.runnerVersion !== undefined ? { runnerVersion: at.runnerVersion } : {}),
      ...(at.requestsPerMinute !== undefined ? { requestsPerMinute: at.requestsPerMinute } : {})
    });
  }

  if (opts.auditRecords !== undefined) {
    const ar = opts.auditRecords;
    await app.register(auditRecordsPlugin, {
      chain: ar.chain,
      sessionStore: ar.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: ar.clock,
      ...(ar.runnerVersion !== undefined ? { runnerVersion: ar.runnerVersion } : {}),
      ...(ar.requestsPerMinute !== undefined ? { requestsPerMinute: ar.requestsPerMinute } : {}),
      ...(ar.defaultLimit !== undefined ? { defaultLimit: ar.defaultLimit } : {}),
      ...(ar.maxLimit !== undefined ? { maxLimit: ar.maxLimit } : {})
    });
  }

  if (opts.sessionState !== undefined) {
    const ss = opts.sessionState;
    await app.register(sessionStatePlugin, {
      persister: ss.persister,
      sessionStore: ss.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: ss.clock,
      ...(ss.runnerVersion !== undefined ? { runnerVersion: ss.runnerVersion } : {}),
      ...(ss.requestsPerMinute !== undefined ? { requestsPerMinute: ss.requestsPerMinute } : {}),
      ...(ss.resumeCtx !== undefined ? { resumeCtx: ss.resumeCtx } : {})
    });
  }

  if (opts.budgetProjection !== undefined) {
    const bp = opts.budgetProjection;
    await app.register(budgetProjectionPlugin, {
      sessionStore: bp.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: bp.clock,
      ...(bp.runnerVersion !== undefined ? { runnerVersion: bp.runnerVersion } : {}),
      ...(bp.requestsPerMinute !== undefined ? { requestsPerMinute: bp.requestsPerMinute } : {}),
      ...(bp.defaultMaxTokensPerRun !== undefined
        ? { defaultMaxTokensPerRun: bp.defaultMaxTokensPerRun }
        : {})
    });
  }

  if (opts.toolsRegistered !== undefined) {
    const tr = opts.toolsRegistered;
    await app.register(toolsRegisteredPlugin, {
      registry: tr.registry,
      sessionStore: tr.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: tr.clock,
      ...(tr.runnerVersion !== undefined ? { runnerVersion: tr.runnerVersion } : {}),
      ...(tr.requestsPerMinute !== undefined ? { requestsPerMinute: tr.requestsPerMinute } : {}),
      ...(tr.registeredAt !== undefined ? { registeredAt: tr.registeredAt } : {})
    });
  }

  if (opts.permissionsDecisions !== undefined) {
    const pd = opts.permissionsDecisions;
    const routeOpts: PermissionsDecisionsRouteOptions = {
      registry: pd.registry,
      sessionStore: pd.sessionStore,
      chain: pd.chain,
      readiness: readiness ?? { check: () => null },
      clock: pd.clock,
      activeCapability: pd.activeCapability,
      ...(pd.toolRequirements !== undefined ? { toolRequirements: pd.toolRequirements } : {}),
      ...(pd.policyEndpoint !== undefined ? { policyEndpoint: pd.policyEndpoint } : {}),
      ...(pd.resolvePdaVerifyKey !== undefined ? { resolvePdaVerifyKey: pd.resolvePdaVerifyKey } : {}),
      ...(pd.isPdaKidRevoked !== undefined ? { isPdaKidRevoked: pd.isPdaKidRevoked } : {}),
      ...(pd.runnerVersion !== undefined ? { runnerVersion: pd.runnerVersion } : {}),
      ...(pd.requestsPerMinute !== undefined ? { requestsPerMinute: pd.requestsPerMinute } : {}),
      ...(pd.sink !== undefined ? { sink: pd.sink } : {}),
      ...(pd.persister !== undefined ? { persister: pd.persister } : {}),
      ...(pd.markers !== undefined ? { markers: pd.markers } : {}),
      ...(pd.toolPoolHash !== undefined ? { toolPoolHash: pd.toolPoolHash } : {}),
      ...(pd.cardVersion !== undefined ? { cardVersion: pd.cardVersion } : {})
    };
    await app.register(permissionsDecisionsPlugin, routeOpts);
  }

  if (opts.auditSinkEvents !== undefined) {
    const se = opts.auditSinkEvents;
    await app.register(auditSinkEventsPlugin, {
      sink: se.sink,
      sessionStore: se.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: se.clock,
      ...(se.runnerVersion !== undefined ? { runnerVersion: se.runnerVersion } : {}),
      ...(se.requestsPerMinute !== undefined ? { requestsPerMinute: se.requestsPerMinute } : {}),
      ...(se.defaultLimit !== undefined ? { defaultLimit: se.defaultLimit } : {}),
      ...(se.maxLimit !== undefined ? { maxLimit: se.maxLimit } : {})
    });
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
