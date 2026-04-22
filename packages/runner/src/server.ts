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
import {
  budgetProjectionPlugin,
  toolsRegisteredPlugin,
  otelSpansRecentPlugin,
  backpressureStatusPlugin
} from "./observability/index.js";
import { eventsRecentPlugin, StreamEventEmitter } from "./stream/index.js";
import { memoryStatePlugin, InMemoryMemoryStateStore } from "./memory/index.js";
import { BudgetTracker } from "./budget/index.js";
import { versionPlugin } from "./governance/index.js";

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
    /** M3-T2 §14.1 StreamEvent emitter — fires SessionStart post-201. */
    emitter?: StreamEventEmitter;
    agentName?: string;
    /** M3-T1 Memory state init on bootstrap. */
    memoryStore?: InMemoryMemoryStateStore;
    /** M3-T4 budget tracker init on bootstrap. */
    budgetTracker?: BudgetTracker;
    /** M3-T13 HR-17 — Memory MCP prefetch + MemoryDegraded emission. */
    memoryClient?: import("./memory/mcp-client.js").MemoryMcpClient;
    memoryDegradation?: import("./memory/mcp-client.js").MemoryDegradationTracker;
    /** L-38 Finding T — per-timeout MemoryDegraded log records. */
    systemLog?: import("./system-log/index.js").SystemLogBuffer;
    /** L-38 Finding V — card-driven sharing_scope for bootstrap prefetch. */
    memoryDefaultSharingScope?: "none" | "session" | "project" | "tenant";
    /** L-37 Finding Q — card.tokenBudget.billingTag snapshot at bootstrap. */
    cardBillingTag?: string;
    /** §19.4.1 SV-GOV-08 — advertised supported Core versions. */
    supportedCoreVersions?: readonly string[];
  };
  /**
   * §19.4.1 / SV-GOV-08 + §19.2 / SV-GOV-05. When present, the Runner
   * exposes GET /version (advertised supported set) and, when errataBody
   * is non-undefined, GET /errata/v1.0.json (static errata body).
   */
  governance?: {
    clock: Clock;
    runnerVersion?: string;
    supportedCoreVersions?: readonly string[];
    errataBody?: unknown;
    errataPath?: string;
    /** Finding AF — HTTP doc routes serving bundled repo artifacts. */
    docRoutes?: readonly import("./governance/index.js").DocRoute[];
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
    /** M3-T2 §14.1 StreamEvent emitter — fires PermissionDecision post-commit. */
    emitter?: StreamEventEmitter;
    /** M3-T6 §15 hooks — PreToolUse before resolver, PostToolUse advisory post-commit. */
    hookConfig?: {
      preToolUseCommand?: readonly string[];
      postToolUseCommand?: readonly string[];
      turnIdFn?: () => string;
    };
    /** M3-T4 §13.1 turn-accounting — recordTurn() fires after each committed decision. */
    budgetTracker?: BudgetTracker;
    budgetPerTurnEstimate?: number;
    /** §15 Finding N — shared hook reentrancy tracker. */
    hookReentrancy?: import("./hook/index.js").HookReentrancyTracker;
    /** §14.4 Finding W — OTel span emission bridge. */
    otelEmitter?: import("./observability/index.js").OtelEmitter;
    /** §13.3 Finding AD — synthetic cache-hit injection from env. */
    syntheticCacheHit?: number;
    /** §10.7.2 SV-PRIV-05 — Card `security.data_residency` pin. */
    dataResidency?: readonly string[];
    /** §10.7.2 per-tool `data_processing_location` metadata lookup. */
    toolResidency?: import("./permission/index.js").ToolResidencyMetadataLookup;
  };
  /** §10.7.1 SV-PRIV-03 — privacy.delete_subject + privacy.export_subject. */
  privacy?: {
    subjectStore: import("./privacy/index.js").InMemorySubjectStore;
    sessionStore: InMemorySessionStore;
    chain: AuditChain;
    clock: Clock;
    runnerVersion?: string;
    operatorBearer?: string;
    emitter?: StreamEventEmitter;
    systemLog?: import("./system-log/index.js").SystemLogBuffer;
    bootSessionId?: string;
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
  /** M3-T3 scaffold + M3-T4: GET /budget/projection (§13.5). */
  budgetProjection?: {
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultMaxTokensPerRun?: number;
    /** M3-T4 real projection state. Omit for T-3-scaffold placeholder behavior. */
    tracker?: BudgetTracker;
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
  /** M3-T2: GET /events/recent (§14.5) polling channel for the §14.1 27-type enum. */
  eventsRecent?: {
    emitter: StreamEventEmitter;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultLimit?: number;
    maxLimit?: number;
  };
  /** M3-T1: GET /memory/state/:session_id (§8.6). */
  memoryState?: {
    memoryStore: InMemoryMemoryStateStore;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
  };
  /** L-36 §14.5.2: GET /observability/otel-spans/recent — session-scoped OTel ring. */
  otelSpansRecent?: {
    store: import("./observability/index.js").OtelSpanStore;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultLimit?: number;
    maxLimit?: number;
  };
  /** L-36 §14.5.3: GET /observability/backpressure — process-global pressure snapshot. */
  backpressureStatus?: {
    state: import("./observability/index.js").BackpressureState;
    sessionStore: SessionStore;
    bootstrapBearer?: string;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
  };
  /** L-38 §14.5.4: GET /logs/system/recent — System Event Log polling surface. */
  systemLogRecent?: {
    buffer: import("./system-log/index.js").SystemLogBuffer;
    sessionStore: SessionStore;
    clock: Clock;
    runnerVersion?: string;
    requestsPerMinute?: number;
    defaultLimit?: number;
    maxLimit?: number;
    /** Finding AN — allow reads under /ready=503. */
    skipReadinessGate?: boolean;
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
      ...(sb.cardVersion !== undefined ? { cardVersion: sb.cardVersion } : {}),
      ...(sb.emitter !== undefined ? { emitter: sb.emitter } : {}),
      ...(sb.agentName !== undefined ? { agentName: sb.agentName } : {}),
      ...(sb.memoryStore !== undefined ? { memoryStore: sb.memoryStore } : {}),
      ...(sb.budgetTracker !== undefined ? { budgetTracker: sb.budgetTracker } : {}),
      ...(sb.memoryClient !== undefined ? { memoryClient: sb.memoryClient } : {}),
      ...(sb.memoryDegradation !== undefined ? { memoryDegradation: sb.memoryDegradation } : {}),
      ...(sb.systemLog !== undefined ? { systemLog: sb.systemLog } : {}),
      ...(sb.memoryDefaultSharingScope !== undefined
        ? { memoryDefaultSharingScope: sb.memoryDefaultSharingScope }
        : {}),
      ...(sb.cardBillingTag !== undefined ? { cardBillingTag: sb.cardBillingTag } : {}),
      ...(sb.supportedCoreVersions !== undefined
        ? { supportedCoreVersions: sb.supportedCoreVersions }
        : {})
    });
  }

  if (opts.governance !== undefined) {
    const gv = opts.governance;
    await app.register(versionPlugin, {
      readiness: readiness ?? { check: () => null },
      clock: gv.clock,
      ...(gv.runnerVersion !== undefined ? { runnerVersion: gv.runnerVersion } : {}),
      ...(gv.supportedCoreVersions !== undefined
        ? { supportedCoreVersions: gv.supportedCoreVersions }
        : {}),
      ...(gv.errataBody !== undefined ? { errataBody: gv.errataBody } : {}),
      ...(gv.errataPath !== undefined ? { errataPath: gv.errataPath } : {}),
      ...(gv.docRoutes !== undefined ? { docRoutes: gv.docRoutes } : {})
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
        : {}),
      ...(bp.tracker !== undefined ? { tracker: bp.tracker } : {})
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

  if (opts.memoryState !== undefined) {
    const ms = opts.memoryState;
    await app.register(memoryStatePlugin, {
      memoryStore: ms.memoryStore,
      sessionStore: ms.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: ms.clock,
      ...(ms.runnerVersion !== undefined ? { runnerVersion: ms.runnerVersion } : {}),
      ...(ms.requestsPerMinute !== undefined ? { requestsPerMinute: ms.requestsPerMinute } : {})
    });
  }

  if (opts.eventsRecent !== undefined) {
    const er = opts.eventsRecent;
    await app.register(eventsRecentPlugin, {
      emitter: er.emitter,
      sessionStore: er.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: er.clock,
      ...(er.runnerVersion !== undefined ? { runnerVersion: er.runnerVersion } : {}),
      ...(er.requestsPerMinute !== undefined ? { requestsPerMinute: er.requestsPerMinute } : {}),
      ...(er.defaultLimit !== undefined ? { defaultLimit: er.defaultLimit } : {}),
      ...(er.maxLimit !== undefined ? { maxLimit: er.maxLimit } : {})
    });
  }

  if (opts.otelSpansRecent !== undefined) {
    const os = opts.otelSpansRecent;
    await app.register(otelSpansRecentPlugin, {
      store: os.store,
      sessionStore: os.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: os.clock,
      ...(os.runnerVersion !== undefined ? { runnerVersion: os.runnerVersion } : {}),
      ...(os.requestsPerMinute !== undefined ? { requestsPerMinute: os.requestsPerMinute } : {}),
      ...(os.defaultLimit !== undefined ? { defaultLimit: os.defaultLimit } : {}),
      ...(os.maxLimit !== undefined ? { maxLimit: os.maxLimit } : {})
    });
  }

  if (opts.backpressureStatus !== undefined) {
    const bs = opts.backpressureStatus;
    await app.register(backpressureStatusPlugin, {
      state: bs.state,
      sessionStore: bs.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: bs.clock,
      ...(bs.bootstrapBearer !== undefined ? { bootstrapBearer: bs.bootstrapBearer } : {}),
      ...(bs.runnerVersion !== undefined ? { runnerVersion: bs.runnerVersion } : {}),
      ...(bs.requestsPerMinute !== undefined ? { requestsPerMinute: bs.requestsPerMinute } : {})
    });
  }

  if (opts.systemLogRecent !== undefined) {
    const sl = opts.systemLogRecent;
    const { systemLogRecentPlugin } = await import("./system-log/index.js");
    await app.register(systemLogRecentPlugin, {
      buffer: sl.buffer,
      sessionStore: sl.sessionStore,
      readiness: readiness ?? { check: () => null },
      clock: sl.clock,
      ...(sl.runnerVersion !== undefined ? { runnerVersion: sl.runnerVersion } : {}),
      ...(sl.requestsPerMinute !== undefined ? { requestsPerMinute: sl.requestsPerMinute } : {}),
      ...(sl.defaultLimit !== undefined ? { defaultLimit: sl.defaultLimit } : {}),
      ...(sl.maxLimit !== undefined ? { maxLimit: sl.maxLimit } : {}),
      ...(sl.skipReadinessGate !== undefined
        ? { skipReadinessGate: sl.skipReadinessGate }
        : {})
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
      ...(pd.cardVersion !== undefined ? { cardVersion: pd.cardVersion } : {}),
      ...(pd.emitter !== undefined ? { emitter: pd.emitter } : {}),
      ...(pd.hookConfig !== undefined ? { hookConfig: pd.hookConfig } : {}),
      ...(pd.budgetTracker !== undefined ? { budgetTracker: pd.budgetTracker } : {}),
      ...(pd.budgetPerTurnEstimate !== undefined
        ? { budgetPerTurnEstimate: pd.budgetPerTurnEstimate }
        : {}),
      ...(pd.hookReentrancy !== undefined ? { hookReentrancy: pd.hookReentrancy } : {}),
      ...(pd.otelEmitter !== undefined ? { otelEmitter: pd.otelEmitter } : {}),
      ...(pd.syntheticCacheHit !== undefined
        ? { syntheticCacheHit: pd.syntheticCacheHit }
        : {}),
      ...(pd.dataResidency !== undefined ? { dataResidency: pd.dataResidency } : {}),
      ...(pd.toolResidency !== undefined ? { toolResidency: pd.toolResidency } : {})
    };
    await app.register(permissionsDecisionsPlugin, routeOpts);
  }

  if (opts.privacy !== undefined) {
    const { privacyPlugin } = await import("./privacy/index.js");
    const pv = opts.privacy;
    await app.register(privacyPlugin, {
      subjectStore: pv.subjectStore,
      sessionStore: pv.sessionStore,
      chain: pv.chain,
      readiness: readiness ?? { check: () => null },
      clock: pv.clock,
      ...(pv.runnerVersion !== undefined ? { runnerVersion: pv.runnerVersion } : {}),
      ...(pv.operatorBearer !== undefined ? { operatorBearer: pv.operatorBearer } : {}),
      ...(pv.emitter !== undefined ? { emitter: pv.emitter } : {}),
      ...(pv.systemLog !== undefined ? { systemLog: pv.systemLog } : {}),
      ...(pv.bootSessionId !== undefined ? { bootSessionId: pv.bootSessionId } : {})
    });
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
