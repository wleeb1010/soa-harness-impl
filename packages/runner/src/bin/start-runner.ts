import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { importPKCS8, type CryptoKey, type KeyObject } from "jose";
import {
  loadInitialTrust,
  parseBootstrapEnv,
  assertBootstrapEnvHooksListenerSafe,
  loadDnssecBootstrap,
  detectSplitBrain,
  RevocationPoller
} from "../bootstrap/index.js";
import { startRunner } from "../server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../card/cert.js";
import { loadConformanceCard } from "../card/conformance-loader.js";
import { checkCardPrecedence } from "../card/precedence-guard.js";
import { createClock } from "../clock/index.js";
import { CrlCache, type Crl, type CrlFetcher } from "../crl/index.js";
import { BootOrchestrator } from "../boot/index.js";
import { InMemorySessionStore, BOOT_SESSION_ID, type Capability } from "../permission/index.js";
import {
  loadToolRegistry,
  ToolPoolStale,
  startDynamicRegistrationWatcher,
  assertDynamicRegistrationListenerSafe,
  loadAgentsMdDenyList,
  assertAgentsMdListenerSafe,
  AgentsMdUnavailableStartup,
  validateAgentsMdBody,
  resolveAgentsMdImports,
  AgentsMdInvalid,
  AgentsMdImportDepthExceeded,
  AgentsMdImportCycle
} from "../registry/index.js";
import {
  AuditChain,
  AuditSink,
  parseAuditSinkFailureModeEnv,
  assertAuditSinkEnvListenerSafe
} from "../audit/index.js";
import {
  SessionPersister,
  scanAndResumeInProgressSessions,
  scanHasHardFailure,
  type ResumeContext,
  type PersistedSideEffect
} from "../session/index.js";
import { composeReadiness } from "../probes/index.js";
import { StreamEventEmitter } from "../stream/index.js";
import { HookReentrancyTracker } from "../hook/index.js";
import { OtelSpanStore, BackpressureState, OtelEmitter } from "../observability/index.js";
import { SystemLogBuffer } from "../system-log/index.js";
import {
  InMemoryMemoryStateStore,
  MemoryMcpClient,
  MemoryDegradationTracker,
  MemoryReadinessProbe,
  runStartupMemoryProbe,
  ConsolidationScheduler,
  parseConsolidationEnv,
  assertConsolidationHooksListenerSafe
} from "../memory/index.js";
import {
  BudgetTracker,
  parseSyntheticCacheHitEnv,
  assertSyntheticCacheHitListenerSafe
} from "../budget/index.js";
import {
  InMemorySubjectStore,
  RetentionSweepScheduler,
  parseRetentionSweepEnv,
  assertRetentionSweepListenerSafe
} from "../privacy/index.js";
import {
  MarkerEmitter,
  parseCrashTestMarkersEnv,
  assertCrashTestMarkersListenerSafe
} from "../markers/index.js";
import { assertBootstrapBearerListenerSafe } from "../guards/index.js";
import type { TrustAnchor } from "../card/verify.js";
import type { Control } from "../registry/index.js";

const TRUST_PATH = process.env.RUNNER_TRUST_PATH ?? "./initial-trust.json";
const CARD_PATH = process.env.RUNNER_CARD_PATH ?? "./agent-card.json";
const CARD_FIXTURE = process.env.RUNNER_CARD_FIXTURE;
const TOOLS_PATH = process.env.RUNNER_TOOLS_PATH;
const TOOLS_FIXTURE = process.env.RUNNER_TOOLS_FIXTURE;
const PORT = Number.parseInt(process.env.RUNNER_PORT ?? "7700", 10);
const HOST = process.env.RUNNER_HOST ?? "0.0.0.0";
const SIGNING_KEY_PATH = process.env.RUNNER_SIGNING_KEY;
const SIGNING_ALG = (process.env.RUNNER_SIGNING_ALG as "EdDSA" | "ES256" | undefined) ?? "EdDSA";
const CERT_CHAIN_PATH = process.env.RUNNER_X5C;
const DEMO_MODE = process.env.RUNNER_DEMO_MODE === "1";
const DEMO_SESSION_SPEC = process.env.RUNNER_DEMO_SESSION;
const BOOTSTRAP_BEARER = process.env.SOA_RUNNER_BOOTSTRAP_BEARER;

function pemCertChainToX5c(pem: string): string[] {
  const matches = pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g);
  const out: string[] = [];
  for (const match of matches) {
    const body = match[1];
    if (!body) continue;
    out.push(body.replace(/\s+/g, ""));
  }
  if (out.length === 0) throw new Error(`RUNNER_X5C=${CERT_CHAIN_PATH} contained no PEM certificates`);
  return out;
}

async function resolveKeyAndX5c(
  kid: string
): Promise<{ privateKey: CryptoKey | KeyObject | Uint8Array; x5c: string[] }> {
  if (SIGNING_KEY_PATH && CERT_CHAIN_PATH) {
    const privateKey = await importPKCS8(readFileSync(SIGNING_KEY_PATH, "utf8"), SIGNING_ALG);
    return { privateKey, x5c: pemCertChainToX5c(readFileSync(CERT_CHAIN_PATH, "utf8")) };
  }
  if (SIGNING_KEY_PATH || CERT_CHAIN_PATH) {
    throw new Error("RUNNER_SIGNING_KEY and RUNNER_X5C must be set together.");
  }
  if (SIGNING_ALG !== "EdDSA") throw new Error(`Ephemeral-key demo only supports EdDSA, got ${SIGNING_ALG}.`);
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${kid},O=SOA-Harness-Demo` });
  console.warn(
    "[start-runner] WARNING: no RUNNER_SIGNING_KEY / RUNNER_X5C — ephemeral Ed25519 keypair + self-signed cert."
  );
  return { privateKey: keys.privateKey, x5c: [cert] };
}

function demoCrlFetcher(now: () => Date): CrlFetcher {
  return async (anchorUri) => {
    const issuedAt = now();
    const crl: Crl = {
      issuer: `CN=Demo CA for ${anchorUri}`,
      issued_at: issuedAt.toISOString(),
      not_after: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      revoked_kids: []
    };
    return crl;
  };
}

interface CardShape {
  security?: {
    trustAnchors?: TrustAnchor[];
    /**
     * §10.7.2 SV-PRIV-05 — ISO-3166 alpha-2 region pin. Empty/unset =
     * no residency constraint. Non-empty = every MCP tool invocation
     * MUST declare a `data_processing_location` that intersects.
     */
    data_residency?: string[];
  };
  permissions?: { activeMode?: Capability; toolRequirements?: Record<string, Control>; policyEndpoint?: string };
  /**
   * §7 Agent Card — token-budget configuration. Finding O (SV-BUD-02):
   * Runner MUST honor card-supplied maxTokensPerRun rather than defaulting
   * to a hardcoded literal. projectionWindow has the same card-driven
   * contract but is less exercised by conformance.
   */
  tokenBudget?: { maxTokensPerRun?: number; projectionWindow?: number; billingTag?: string };
  /** §14.4 observability config — Finding W reads requiredResourceAttrs. */
  observability?: { otelExporter?: string; requiredResourceAttrs?: string[] };
  /**
   * §7.318 memory config — Finding AA/SV-MEM-06 canonical key is
   * `sharing_policy`. Legacy `default_sharing_scope` name accepted as
   * a fallback so pre-L-40 card fixtures still resolve without a spec
   * rewrite. Enum values: "none" | "session" | "project" | "tenant"
   * (SharingPolicy).
   */
  memory?: {
    sharing_policy?: "none" | "session" | "project" | "tenant";
    /** @deprecated L-40 renamed to `sharing_policy`; retained for old fixtures. */
    default_sharing_scope?: "none" | "session" | "project" | "tenant";
  };
  /**
   * §19.4.1 wire-level version advertisement (SV-GOV-08). `"A.B"`-pattern
   * array; MUST include `soaHarnessVersion`. Absent = Runner falls back
   * to its built-in supported set.
   */
  supported_core_versions?: string[];
  /**
   * §7 / §9 self-improvement entrypoint declaration. L-46 pinned
   * `entrypoint_file` as the canonical path; AGENTS.md's
   * `## Self-Improvement Policy → entrypoint:` line MUST match it.
   * Finding BA / SV-AGENTS-08 threads this through the AGENTS.md body
   * validator.
   */
  self_improvement?: { entrypoint_file?: string };
  /**
   * §11.2 agentType axis. `explore` restricts the per-session tool pool
   * to `risk_class = ReadOnly` (Finding AV / HR-07). Other values
   * impose no additional pool filter today.
   */
  agentType?: string;
}

async function main() {
  // T-05: refuse startup when SOA_RUNNER_BOOTSTRAP_BEARER is set AND TLS is
  // binding a non-loopback host. Full socket separation is M2.
  // (Current demo bin doesn't actually enable TLS — RUNNER_SIGNING_KEY +
  // RUNNER_X5C together flip the flag. The guard checks before startRunner.)
  const tlsEnabled = Boolean(SIGNING_KEY_PATH && CERT_CHAIN_PATH);
  assertBootstrapBearerListenerSafe({ bearer: BOOTSTRAP_BEARER, tlsEnabled, host: HOST });

  // §12.5.2 production guard for the audit-sink failure-mode env hook.
  const AUDIT_SINK_FAILURE_MODE = process.env.SOA_RUNNER_AUDIT_SINK_FAILURE_MODE;
  assertAuditSinkEnvListenerSafe({ envValue: AUDIT_SINK_FAILURE_MODE, host: HOST });

  // §5.3.3 Findings AP/AQ/AR — bootstrap testability env hooks.
  // Parsed up front so the guard fires before any fixture read.
  const bootstrapEnv = parseBootstrapEnv(process.env);
  assertBootstrapEnvHooksListenerSafe({ env: bootstrapEnv, host: HOST });

  // §12.5.3 crash-test marker emission + production guard.
  const markersEnabled = parseCrashTestMarkersEnv(process.env.RUNNER_CRASH_TEST_MARKERS);
  assertCrashTestMarkersListenerSafe({ enabled: markersEnabled, host: HOST });

  // §11.3.1 dynamic-registration env hook + production guard.
  const DYNAMIC_REG_TRIGGER = process.env.SOA_RUNNER_DYNAMIC_TOOL_REGISTRATION;
  assertDynamicRegistrationListenerSafe({
    triggerPath: DYNAMIC_REG_TRIGGER,
    host: HOST
  });

  // §11.2.1 AGENTS.md source-path test hook + production guard. When
  // SOA_RUNNER_AGENTS_MD_PATH is set, load the deny-list BEFORE the
  // Tool Registry so denied tools never enter the pool. Fail-startup
  // with AgentsMdUnavailableStartup on missing/unreadable file.
  const AGENTS_MD_PATH = process.env.SOA_RUNNER_AGENTS_MD_PATH;
  assertAgentsMdListenerSafe({ agentsMdPath: AGENTS_MD_PATH, host: HOST });
  let agentsMdDenied: Set<string> | undefined;
  // Finding AT — collect grammar/import/entrypoint violations so the
  // systemLog-available block downstream can emit the
  // ConfigPrecedenceViolation-shaped record and pin /ready at 503.
  // Exceptions are captured rather than thrown so the emission happens
  // through the observable path (same pattern as Finding AN).
  let agentsMdValidationErr: Error | null = null;
  if (AGENTS_MD_PATH) {
    try {
      const loaded = loadAgentsMdDenyList(AGENTS_MD_PATH);
      agentsMdDenied = loaded.denied;
      console.log(
        `[start-runner] AGENTS.md deny-list loaded from ${AGENTS_MD_PATH} ` +
          `(${agentsMdDenied.size} tool(s) denied: ${[...agentsMdDenied].join(", ") || "<none>"})`
      );
    } catch (err) {
      if (err instanceof AgentsMdUnavailableStartup) {
        console.error(
          `[start-runner] FATAL: AgentsMdUnavailableStartup reason=${err.reason} ` +
            `path=${err.path} — per §11.2.1 refusing to open listener.`
        );
        process.exit(1);
      }
      throw err;
    }

    // Finding AT / §7.2 + §7.3 full-grammar validation runs AFTER card
    // load so Finding BA / SV-AGENTS-08 can thread
    // `card.self_improvement.entrypoint_file` into the entrypoint-mismatch
    // check. See block below the card load.
  }
  const markers = new MarkerEmitter({ enabled: markersEnabled });
  if (markersEnabled) {
    console.log(`[start-runner] crash-test markers enabled (RUNNER_CRASH_TEST_MARKERS=1)`);
  }

  const clock = createClock({
    envClock: process.env.RUNNER_TEST_CLOCK,
    nodeEnv: process.env.NODE_ENV,
    tlsEnabled,
    host: HOST
  });

  // T-07: accept either RUNNER_INITIAL_TRUST (canonical) or the legacy
  // RUNNER_TRUST_PATH. Both map to the §5.3 initial-trust.json source.
  const trustPath = process.env.RUNNER_INITIAL_TRUST ?? TRUST_PATH;
  const expectedPublisherKid = process.env.RUNNER_EXPECTED_PUBLISHER_KID;
  // Finding AP / SV-BOOT-03 — when SOA_BOOTSTRAP_DNSSEC_TXT is set, the
  // pinned fixture replaces the normal initial-trust.json read.
  // Validator drives the three scenarios (valid, empty, missing-ad-bit)
  // through this path; missing-AD and empty cases raise
  // HostHardeningInsufficient exactly as a live DNSSEC resolver failure
  // would.
  let trust;
  if (bootstrapEnv.dnssecTxtPath !== undefined) {
    console.log(
      `[start-runner] §5.3.3 Finding AP — loading bootstrap anchor from DNSSEC fixture ${bootstrapEnv.dnssecTxtPath}`
    );
    trust = loadDnssecBootstrap({
      path: bootstrapEnv.dnssecTxtPath,
      ...(expectedPublisherKid !== undefined ? { expectedPublisherKid } : {})
    });
  } else {
    trust = loadInitialTrust({
      path: trustPath,
      now: clock(),
      ...(expectedPublisherKid !== undefined ? { expectedPublisherKid } : {})
    });
  }
  // Finding AR / SV-BOOT-05 — multi-channel split-brain detection.
  // When SOA_BOOTSTRAP_SECONDARY_CHANNEL is set, compare the secondary
  // against the authoritative trust. Disagreement raises
  // HostHardeningInsufficient(bootstrap-split-brain) per §5.3.2 rule 2.
  if (bootstrapEnv.secondaryChannelPath !== undefined) {
    detectSplitBrain({
      authoritative: trust,
      secondaryPath: bootstrapEnv.secondaryChannelPath,
      authoritativeChannel: trust.channel ?? "sdk-pinned"
    });
  }
  const { privateKey, x5c } = await resolveKeyAndX5c(trust.publisher_kid);

  // Card source: when RUNNER_CARD_FIXTURE is set, load the pinned conformance
  // fixture (T-04) and substitute the placeholder SPKI with the runtime key's
  // actual SPKI. Otherwise fall back to the operator-supplied RUNNER_CARD_PATH.
  let card: CardShape;
  let skipCardSchemaValidation = false;
  if (CARD_FIXTURE) {
    const leafDer = x5c[0];
    if (!leafDer) throw new Error("conformance-fixture: runtime signing cert chain is empty");
    const loaded = await loadConformanceCard({ fixturePath: CARD_FIXTURE, leafCertDerBase64: leafDer });
    card = loaded.card as CardShape;
    skipCardSchemaValidation = true; // fixture is trusted by spec digest, not by schema
    console.log(
      `[start-runner] loaded conformance card (digest ${loaded.fixtureDigest.slice(0, 12)}…); ` +
        `substituted SPKI ${loaded.substitutedSpki.slice(0, 12)}…`
    );
  } else {
    card = JSON.parse(readFileSync(CARD_PATH, "utf8")) as CardShape;
  }
  const anchors = card.security?.trustAnchors ?? [];

  // Finding AT / §7.2 + §7.3 full-grammar validation. Runs AFTER card load
  // so Finding BA / SV-AGENTS-08 can thread
  // `card.self_improvement.entrypoint_file` into the entrypoint-mismatch
  // check. Import resolution happens before body validation so cycle/depth
  // detection runs against the full reachable graph.
  if (AGENTS_MD_PATH) {
    try {
      const resolved = resolveAgentsMdImports(AGENTS_MD_PATH);
      const cardEntrypoint = card.self_improvement?.entrypoint_file;
      validateAgentsMdBody(
        resolved,
        cardEntrypoint !== undefined ? { cardEntrypointFile: cardEntrypoint } : {}
      );
      console.log(
        `[start-runner] AGENTS.md §7.2/§7.3 validation passed for ${AGENTS_MD_PATH}` +
          (cardEntrypoint !== undefined
            ? ` (entrypoint="${cardEntrypoint}" matched Card self_improvement.entrypoint_file)`
            : " (Card self_improvement.entrypoint_file absent — entrypoint check skipped)")
      );
    } catch (err) {
      if (
        err instanceof AgentsMdInvalid ||
        err instanceof AgentsMdImportDepthExceeded ||
        err instanceof AgentsMdImportCycle
      ) {
        agentsMdValidationErr = err;
        console.error(
          `[start-runner] Finding AT — AGENTS.md refused: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  // L-24 — when RUNNER_CARD_FIXTURE is set, load the pinned conformance handler
  // public key alongside the card and expose it via resolvePdaVerifyKey so
  // POST /permissions/decisions can verify the spec's pre-signed PDA fixture.
  // The fixture path is derived from CARD_FIXTURE (sibling test-vectors dir);
  // operators MAY override via RUNNER_HANDLER_KEY_PEM.
  let conformanceHandlerKey: import("jose").CryptoKey | import("jose").KeyObject | null = null;
  if (CARD_FIXTURE) {
    const { importSPKI } = await import("jose");
    const { createHash, createPublicKey } = await import("node:crypto");
    const explicitPem = process.env.RUNNER_HANDLER_KEY_PEM;
    const derivedPem = (() => {
      const dir = dirname(dirname(CARD_FIXTURE));
      return `${dir}/handler-keypair/public.pem`;
    })();
    const pemPath = explicitPem ?? derivedPem;
    if (existsSync(pemPath)) {
      const pem = readFileSync(pemPath, "utf8");
      // Belt-and-suspenders: compute SPKI sha256 of the PEM's DER and verify
      // it matches trustAnchors[1] before wiring the resolver. Drift → refuse.
      const pubKeyObj = createPublicKey(pem);
      const spkiDer = pubKeyObj.export({ format: "der", type: "spki" }) as Buffer;
      const spkiHash = createHash("sha256").update(spkiDer).digest("hex");
      const pinnedAnchor = anchors.find((a) => a.spki_sha256.toLowerCase() === spkiHash);
      if (!pinnedAnchor) {
        console.error(
          `[start-runner] FATAL: handler public key at ${pemPath} has SPKI ${spkiHash} ` +
            `which does not match any trustAnchors entry — refusing to wire the PDA verify-key resolver.`
        );
        process.exit(1);
      }
      conformanceHandlerKey = await importSPKI(pem, "EdDSA");
      console.log(
        `[start-runner] wired conformance handler key for kid=${pinnedAnchor.publisher_kid} ` +
          `(SPKI ${spkiHash.slice(0, 12)}…)`
      );
    }
  }

  // T-06 — RUNNER_CARD_JWS: when set, verify a pre-supplied detached JWS
  // against the loaded card + anchors at boot. Verification failure aborts
  // startup with a non-zero exit (HR-12: tampered-card rejection).
  const CARD_JWS_PATH = process.env.RUNNER_CARD_JWS;
  if (CARD_JWS_PATH) {
    const { loadAndVerifyExternalCardJws } = await import("../card/external-jws-loader.js");
    const { jcsBytes } = await import("@soa-harness/core");
    try {
      await loadAndVerifyExternalCardJws({
        jwsPath: CARD_JWS_PATH,
        canonicalBody: jcsBytes(card),
        trustAnchors: anchors
      });
      console.log(`[start-runner] RUNNER_CARD_JWS verified against card trust anchors`);
    } catch (err) {
      console.error(
        `[start-runner] FATAL: RUNNER_CARD_JWS verification failed (HR-12 / CardSignatureFailed): `,
        err
      );
      process.exit(1);
    }
  }

  const crl = new CrlCache({
    fetcher: DEMO_MODE
      ? demoCrlFetcher(clock)
      : async () => {
          throw new Error("RUNNER_DEMO_MODE=0 and no production CRL fetcher configured.");
        },
    now: clock
  });
  const boot = new BootOrchestrator({ anchors, crl });

  const sessionStore = new InMemorySessionStore();
  // Finding AO — register the runner-boot session so bootstrap-scoped
  // bearers can read GET /logs/system/recent for boot-lifetime records
  // (startup probes, retention sweeps, consolidation ticks,
  // ConfigPrecedenceViolation from Finding AN). The bootstrap bearer
  // doubles as the session_bearer for this synthetic session; no
  // §12.6 POST /sessions flow is used. session_id matches the
  // §12.1 pattern so /logs/system/recent's parameter validator
  // accepts it.
  if (BOOTSTRAP_BEARER !== undefined) {
    sessionStore.register(BOOT_SESSION_ID, BOOTSTRAP_BEARER, {
      activeMode: "ReadOnly",
      user_sub: "runner-boot",
      created_at: clock(),
      // Boot session stays live for the Runner's lifetime — pin the
      // expiry far enough out that typical conformance runs never race
      // against it. Real §12.6 sessions still use the 60-86400s default.
      expires_at: new Date(clock().getTime() + 365 * 24 * 60 * 60 * 1000),
      canDecide: false
    });
    console.log(
      `[start-runner] Finding AO — registered boot session ${BOOT_SESSION_ID} so bootstrap bearer can poll /logs/system/recent for boot-lifetime records`
    );
  }
  if (DEMO_SESSION_SPEC) {
    const parts = DEMO_SESSION_SPEC.split(":");
    const sid = parts[0];
    const bearer = parts[1];
    const mode = parts[2];
    if (!sid || !bearer) throw new Error(`RUNNER_DEMO_SESSION must be "<sid>:<bearer>[:<activeMode>]"`);
    const activeMode = (mode && ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"].includes(mode)
      ? mode
      : "WorkspaceWrite") as Capability;
    sessionStore.register(sid, bearer, { activeMode, canDecide: true });
    console.log(
      `[start-runner] pre-registered demo session ${sid} (activeMode=${activeMode}, canDecide=true)`
    );
  }

  const registryPath = TOOLS_FIXTURE ?? TOOLS_PATH ?? (existsSync("./tools.json") ? "./tools.json" : undefined);
  let registry: ReturnType<typeof loadToolRegistry> | undefined;
  if (registryPath) {
    try {
      registry = loadToolRegistry(
        registryPath,
        agentsMdDenied ? { denied: agentsMdDenied } : {}
      );
      // §11.4 — stamp static-fixture tools with source + boot-time
      // registered_at so /tools/registered reflects per-tool metadata
      // consistently whether the tool came from the fixture or a later
      // §11.3.1 dynamic add.
      const nowIso = clock().toISOString();
      for (const name of registry.names()) {
        const t = registry.mustLookup(name);
        if (!t._registered_at) t._registered_at = nowIso;
        if (!t._registration_source) t._registration_source = "static-fixture";
      }
      const label = TOOLS_FIXTURE ? "conformance fixture" : "operator registry";
      console.log(`[start-runner] loaded ${registry.size()} tool(s) from ${label}: ${registryPath}`);
    } catch (err) {
      if (err instanceof ToolPoolStale) {
        // §12.2 — the Runner MUST NOT open any listener when the Tool Registry
        // fails classification. Loud line + non-zero exit; listener never binds.
        console.error(
          `[start-runner] FATAL: ToolPoolStale reason=${err.reason} tool="${err.offendingTool}" ` +
            `(registry=${registryPath}) — per §12.2 refusing to open listener.`
        );
        process.exit(1);
      }
      throw err;
    }
  }

  const chain = new AuditChain(clock, { markers });
  const activeCapability = (card.permissions?.activeMode ?? "ReadOnly") as Capability;

  // §12.5.3 RUNNER_SESSION_DIR override (production-safe; tests use it for
  // per-test isolation). Default lives next to the Runner process; operators
  // SHOULD put it on a durable-disk mount in production.
  const sessionDir = process.env.RUNNER_SESSION_DIR ?? "./sessions";
  const persister = new SessionPersister({ sessionDir, markers });

  // §10.5.1 audit-sink state machine. Env hook (§12.5.2) drives initial
  // state at boot; L-28 F-13 requires exactly one matching AuditSink*
  // event for a fresh process with the env set.
  const initialSinkState = parseAuditSinkFailureModeEnv(AUDIT_SINK_FAILURE_MODE);
  const auditSink = new AuditSink({
    sessionDir,
    clock,
    markers,
    ...(initialSinkState !== null
      ? { initialState: initialSinkState, initialReason: "env-test-hook" as const }
      : {})
  });
  if (initialSinkState !== null && initialSinkState !== "healthy") {
    console.log(
      `[start-runner] AuditSink booted in ${initialSinkState} state (env hook); ` +
        `emitted ${auditSink.snapshotEvents().length} event(s)`
    );
  }

  // M3-T2 StreamEvent emitter — one instance shared across sessions-
  // bootstrap, decisions, events-recent, and future T-1 Memory / T-4
  // Budget emission sites.
  const streamEmitter = new StreamEventEmitter({ clock });

  // §15 Finding N / SV-HOOK-08 — per-Runner hook reentrancy tracker.
  // Passed to the decisions plugin so every Pre/PostToolUse runHook
  // invocation registers + deregisters its child PID; inbound requests
  // carrying x-soa-hook-pid matching an in-flight hook are rejected
  // with 403 hook-reentrancy + SessionEnd{stop_reason:"HookReentrancy"}.
  const hookReentrancy = new HookReentrancyTracker();

  // L-36 §14.5.2 OTel span ring buffer + §14.5.3 process-global
  // backpressure state. Producer-side wiring (OTel SDK integration,
  // buffer-overrun detection) lands in M4; M3 endpoints serve cold-state
  // empty buffers + zero counters so the validator's SV-STR-06/07/08
  // probes pin on the schema shape independent of producer timing.
  const otelSpanStore = new OtelSpanStore();
  const backpressureState = new BackpressureState({ clock });

  // Finding W / SV-STR-06/07 — bridge that emits soa.turn + soa.tool.*
  // spans from every committed decision into the OTel ring. billingTag
  // flows from card.tokenBudget.billingTag when Finding Q ships the
  // end-to-end threading; until then the card fixture's value is used
  // directly so the span attribute is present with a real value.
  const agentNameForSpans =
    typeof (card as { name?: unknown }).name === "string"
      ? ((card as { name: string }).name)
      : "soa-harness-runner";
  const agentVersionForSpans =
    typeof (card as { version?: unknown }).version === "string"
      ? ((card as { version: string }).version)
      : "1.0";
  const billingTagForSpans =
    typeof card.tokenBudget?.billingTag === "string" ? card.tokenBudget.billingTag : "";
  const requiredAttrs = card.observability?.requiredResourceAttrs;
  const otelEmitter = new OtelEmitter({
    store: otelSpanStore,
    agentName: agentNameForSpans,
    agentVersion: agentVersionForSpans,
    billingTag: billingTagForSpans,
    ...(requiredAttrs !== undefined ? { requiredResourceAttrs: requiredAttrs } : {}),
    runnerVersion: "1.0",
    clock
  });

  // L-38 §14.2/§14.5.4 System Event Log buffer. Finding T writes
  // per-timeout MemoryDegraded records here; GET /logs/system/recent
  // surfaces them. Buffer is session-scoped + category-filtered.
  const systemLog = new SystemLogBuffer({ clock });

  // Findings AN + AW / SV-CARD-10 + HR-11 — §10.3 three-axis precedence
  // guard. A Card that loosens a lower-precedence axis against a higher
  // one is refused: we write a Config/ConfigPrecedenceViolation/error
  // log record per violation under BOOT_SESSION_ID and pin /ready at
  // 503 so the Runner never advertises readiness until an operator
  // fixes the Card. Axis 3 (Finding AW) requires the Tool Registry's
  // default_control per tool — extracted lazily since the registry is
  // optional at boot.
  const toolDefaultControls =
    registry !== undefined
      ? new Map(registry.names().map((n) => [n, registry.mustLookup(n).default_control]))
      : undefined;
  const precedenceResult = checkCardPrecedence({
    card: card as CardShape,
    ...(agentsMdDenied !== undefined ? { agentsMdDenied } : {}),
    ...(toolDefaultControls !== undefined ? { toolDefaultControls } : {})
  });
  if (!precedenceResult.ok) {
    for (const v of precedenceResult.violations) {
      systemLog.write({
        session_id: BOOT_SESSION_ID,
        category: "Config",
        level: "error",
        code: "ConfigPrecedenceViolation",
        message: v.message,
        data: { axis: v.axis, ...v.detail }
      });
    }
    console.error(
      `[start-runner] Finding AN — Agent Card refused: ${precedenceResult.violations
        .map((v) => v.message)
        .join(" | ")}`
    );
  }
  const cardPrecedenceReadiness = {
    check: () =>
      precedenceResult.ok ? null : ("bootstrap-pending" as const)
  };

  // Finding AT — surface AGENTS.md grammar/import errors on the
  // observability channel. The error was captured pre-systemLog; we
  // emit the record here now that the buffer exists. Same shape as
  // Finding AN: Config/<code>/error under BOOT_SESSION_ID +
  // readiness source pins /ready at 503 until the operator fixes
  // AGENTS.md.
  if (agentsMdValidationErr !== null) {
    const err = agentsMdValidationErr;
    let code: string;
    let data: Record<string, unknown>;
    if (err instanceof AgentsMdInvalid) {
      code = "AgentsMdInvalid";
      data = { reason: err.reason, ...err.data };
    } else if (err instanceof AgentsMdImportDepthExceeded) {
      code = "AgentsMdImportDepthExceeded";
      data = { path: err.path, depth: err.depth };
    } else if (err instanceof AgentsMdImportCycle) {
      code = "AgentsMdImportCycle";
      data = { path: err.path, cycle: [...err.cycle] };
    } else {
      code = "AgentsMdInvalid";
      data = { reason: "unknown" };
    }
    systemLog.write({
      session_id: BOOT_SESSION_ID,
      category: "Config",
      level: "error",
      code,
      message: err.message,
      data
    });
  }
  const agentsMdReadiness = {
    check: () =>
      agentsMdValidationErr === null ? null : ("bootstrap-pending" as const)
  };

  // Finding AQ / SV-BOOT-04 — revocation file watcher. When
  // SOA_BOOTSTRAP_REVOCATION_FILE is set, poll the path at
  // RUNNER_BOOTSTRAP_POLL_TICK_MS (default 1 h). Matching
  // publisher_kid flips the Runner into the §5.3.1 revocation
  // refusal state: write a Config/bootstrap-revoked/error record
  // under BOOT_SESSION_ID and pin /ready at 503.
  let bootstrapRevoked = false;
  let revocationPoller: RevocationPoller | undefined;
  if (bootstrapEnv.revocationFilePath !== undefined) {
    revocationPoller = new RevocationPoller({
      filePath: bootstrapEnv.revocationFilePath,
      expectedPublisherKid: trust.publisher_kid,
      tickMs: bootstrapEnv.pollTickMs ?? 60 * 60 * 1000,
      onRevoked: (record) => {
        bootstrapRevoked = true;
        systemLog.write({
          session_id: BOOT_SESSION_ID,
          category: "Config",
          level: "error",
          code: "bootstrap-revoked",
          message:
            `Bootstrap anchor ${trust.publisher_kid} revoked via file ` +
            `${bootstrapEnv.revocationFilePath}`,
          data: {
            publisher_kid: record.publisher_kid,
            reason: record.reason ?? "unspecified",
            revoked_at: record.revoked_at ?? new Date().toISOString()
          }
        });
        console.error(
          `[start-runner] Finding AQ — bootstrap revocation observed for publisher_kid=${record.publisher_kid}; /ready pinned at 503`
        );
      },
      log: (m) => console.log(m)
    });
    revocationPoller.start();
    console.log(
      `[start-runner] §5.3.3 Finding AQ — revocation poller active (file=${bootstrapEnv.revocationFilePath}, tick=${bootstrapEnv.pollTickMs ?? 3600000}ms)`
    );
  }
  const bootstrapRevocationReadiness = {
    check: () => (bootstrapRevoked ? ("bootstrap-pending" as const) : null)
  };

  // M3-T1 Memory state store — per-session zero-state initialized at
  // §12.6 bootstrap. Full §8 client (search / write / consolidate /
  // aging) fills in incrementally as SV-MEM-01..08 wire up.
  const memoryStore = new InMemoryMemoryStateStore({
    clock,
    defaultSharingPolicy: "session",
    defaultAging: {
      temporal_indexing: false,
      consolidation_threshold: "oldest-first",
      max_in_context_tokens: 16_000
    }
  });

  // M3-T4 Budget tracker — §13.1 p95-over-W projection state. Each
  // session gets zero-state initialized at §12.6 bootstrap; real turn
  // recording wires in when the tool-invocation dispatch path lands.
  //
  // Finding O / SV-BUD-02: maxTokensPerRun is a §7 required Agent Card
  // field — Runner MUST read card.tokenBudget.maxTokensPerRun (pattern
  // enforced at card-schema load time) rather than defaulting to a
  // hardcoded literal. Keep a fallback for cards that predate §7 field
  // (shouldn't happen at this pin; belt-and-suspenders).
  const cardMax =
    typeof card.tokenBudget?.maxTokensPerRun === "number"
      ? card.tokenBudget.maxTokensPerRun
      : undefined;
  const cardWindow =
    typeof card.tokenBudget?.projectionWindow === "number"
      ? card.tokenBudget.projectionWindow
      : undefined;
  const budgetTracker = new BudgetTracker({
    projectionWindow: cardWindow ?? 10,
    ...(cardMax !== undefined ? { maxTokensPerRun: cardMax } : {})
  });
  if (cardMax !== undefined) {
    console.log(
      `[start-runner] BudgetTracker wired to card.tokenBudget.maxTokensPerRun=${cardMax}` +
        (cardWindow !== undefined ? ` (projectionWindow=${cardWindow})` : "")
    );
  }

  // M3-T13 HR-17 — Memory MCP client (conditional on env). When
  // SOA_RUNNER_MEMORY_MCP_ENDPOINT is set, each new session attempts a
  // prefetch; on MemoryTimeout the runner emits SessionEnd{stop_reason:
  // "MemoryDegraded"} per §8.3.1. The mock lives at :8001 in the default
  // test harness; production deployments point at the real MCP server.
  const MEMORY_MCP_ENDPOINT = process.env["SOA_RUNNER_MEMORY_MCP_ENDPOINT"];
  const memoryClient = MEMORY_MCP_ENDPOINT
    ? new MemoryMcpClient({ endpoint: MEMORY_MCP_ENDPOINT })
    : undefined;
  const memoryDegradation = MEMORY_MCP_ENDPOINT ? new MemoryDegradationTracker(3) : undefined;
  // Finding S / SV-MEM-03 — the readiness probe is always present so
  // composeReadiness() sees a stable shape; when Memory MCP isn't wired
  // it markReady()'s immediately (no dependency to probe).
  const memoryReadiness = new MemoryReadinessProbe();
  if (MEMORY_MCP_ENDPOINT) {
    console.log(`[start-runner] Memory MCP client wired to ${MEMORY_MCP_ENDPOINT}`);
  } else {
    // No Memory MCP — skip the §8.3 startup probe; deployments without
    // memory wiring MUST NOT gate /ready on a non-existent dependency.
    memoryReadiness.markReady();
  }

  // Finding S: run the startup probe BEFORE binding the public listener.
  // On persistent failure the probe flips memoryReadiness to
  // `unavailable`; composeReadiness below keeps /ready at 503 with
  // reason=memory-mcp-unavailable until the Runner is restarted with a
  // repaired dependency. §8.3 line 581 forbids fail-open to empty memory.
  if (MEMORY_MCP_ENDPOINT && memoryClient) {
    await runStartupMemoryProbe({
      client: memoryClient,
      probe: memoryReadiness,
      systemLog
    });
  }

  // Finding U / SV-MEM-05 — §8.4 consolidation scheduler. Default
  // 24 h elapsed-time trigger + 100-note-per-session threshold.
  //
  // Finding AC / §8.4.1 test hooks — RUNNER_CONSOLIDATION_TICK_MS +
  // RUNNER_CONSOLIDATION_ELAPSED_MS override the poll interval and
  // elapsed threshold respectively. Production guard refuses startup
  // when either env is set and the listener binds to a non-loopback
  // host (same pattern as §11.3.1 dynamic registration).
  const consolidationEnv = parseConsolidationEnv(process.env);
  assertConsolidationHooksListenerSafe({ env: consolidationEnv, host: HOST });

  // Finding AD / SV-BUD-04 — synthetic cache-hit injection env hook.
  // When RUNNER_SYNTHETIC_CACHE_HIT=<n> is set (loopback-only per the
  // production guard), every committed recordTurn stamps both cache
  // fields to <n>. Lets validators exercise non-zero
  // cache_accounting totals without a real LLM round-trip.
  const syntheticCacheCfg = parseSyntheticCacheHitEnv(process.env);
  assertSyntheticCacheHitListenerSafe({ cfg: syntheticCacheCfg, host: HOST });
  if (syntheticCacheCfg.value !== undefined) {
    console.log(
      `[start-runner] synthetic cache-hit hook active: every recordTurn stamps ${syntheticCacheCfg.value} into prompt_tokens_cached + completion_tokens_cached`
    );
  }
  const consolidationScheduler =
    MEMORY_MCP_ENDPOINT && memoryClient
      ? new ConsolidationScheduler({
          client: memoryClient,
          systemLog,
          clock,
          ...(consolidationEnv.tickIntervalMs !== undefined
            ? { tickIntervalMs: consolidationEnv.tickIntervalMs }
            : {}),
          ...(consolidationEnv.intervalMs !== undefined
            ? { intervalMs: consolidationEnv.intervalMs }
            : {})
        })
      : undefined;
  if (consolidationScheduler) {
    consolidationScheduler.start();
    const tickMs = consolidationEnv.tickIntervalMs ?? 5 * 60 * 1000;
    const elapsedMs = consolidationEnv.intervalMs ?? 24 * 60 * 60 * 1000;
    const hookNote =
      consolidationEnv.tickIntervalMs !== undefined ||
      consolidationEnv.intervalMs !== undefined
        ? " [§8.4.1 test hooks active]"
        : "";
    console.log(
      `[start-runner] Memory consolidation scheduler started (tick=${tickMs}ms, elapsed=${elapsedMs}ms, 100-note threshold)${hookNote}`
    );
  }

  // §19.2 SV-GOV-05 — load the static errata body at boot so GET
  // /errata/v1.0.json returns a 200 JSON. The canonical path is
  // resolved relative to the repo root; operators can override via
  // RUNNER_ERRATA_PATH for deployment-specific errata feeds.
  const ERRATA_PATH =
    process.env.RUNNER_ERRATA_PATH ?? "docs/errata-v1.0.json";
  let errataBody: unknown;
  if (existsSync(ERRATA_PATH)) {
    try {
      errataBody = JSON.parse(readFileSync(ERRATA_PATH, "utf8"));
    } catch (err) {
      console.warn(
        `[start-runner] errata load failed at ${ERRATA_PATH}: ${
          err instanceof Error ? err.message : String(err)
        }; /errata/v1.0.json will be unavailable`
      );
    }
  }

  // Finding AF — HTTP doc routes. Load each deployment-bundled artifact
  // at boot so validator probes don't need filesystem access. Missing
  // files are logged + skipped (not fatal) so a partial-scaffold deploy
  // still starts. Every route cached in memory; per-request disk IO = 0.
  const docRouteCandidates: Array<{
    path: string;
    route: string;
    contentType: string;
  }> = [
    { path: "docs/data-inventory.md", route: "/docs/data-inventory.md", contentType: "text/markdown; charset=utf-8" },
    { path: "docs/stability-tiers.md", route: "/docs/stability-tiers.md", contentType: "text/markdown; charset=utf-8" },
    { path: "docs/migrations/README.md", route: "/docs/migrations/README.md", contentType: "text/markdown; charset=utf-8" },
    { path: "docs/errata-v1.0.json", route: "/docs/errata-v1.0.json", contentType: "application/json; charset=utf-8" },
    { path: "release-gate.json", route: "/release-gate.json", contentType: "application/json; charset=utf-8" }
  ];
  const docRoutes: Array<{ route: string; body: string; contentType: string }> = [];
  for (const c of docRouteCandidates) {
    if (!existsSync(c.path)) {
      console.warn(`[start-runner] Finding AF: ${c.path} missing; ${c.route} unavailable`);
      continue;
    }
    try {
      docRoutes.push({ route: c.route, body: readFileSync(c.path, "utf8"), contentType: c.contentType });
    } catch (err) {
      console.warn(
        `[start-runner] Finding AF: failed to load ${c.path}: ${
          err instanceof Error ? err.message : String(err)
        }; ${c.route} unavailable`
      );
    }
  }

  // §10.7.1 SV-PRIV-03 — subject store for privacy.delete_subject +
  // privacy.export_subject endpoints. In-memory mirror for M3; full
  // persisted mirror is post-M3 scope.
  const subjectStore = new InMemorySubjectStore();

  // §10.7.3 SV-PRIV-04 — retention-sweep scheduler. 24h cadence (default);
  // emits a System Event Log record each pass. M3 hooks are no-op
  // counters since the Runner doesn't yet populate retention-tracked
  // persisted state beyond the audit chain.
  //
  // Finding AH — RUNNER_RETENTION_SWEEP_{TICK,INTERVAL}_MS env hooks
  // override the cadence for conformance probes. Loopback-only guard
  // per the §8.4.1 / §11.3.1 / §10.6.1 test-hook pattern.
  const retentionSweepEnv = parseRetentionSweepEnv(process.env);
  assertRetentionSweepListenerSafe({ env: retentionSweepEnv, host: HOST });
  const retentionSweeper = new RetentionSweepScheduler({
    systemLog,
    clock,
    log: (m) => console.log(m),
    ...(retentionSweepEnv.tickIntervalMs !== undefined
      ? { tickIntervalMs: retentionSweepEnv.tickIntervalMs }
      : {}),
    ...(retentionSweepEnv.intervalMs !== undefined
      ? { intervalMs: retentionSweepEnv.intervalMs }
      : {})
  });
  retentionSweeper.start();
  const retentionTickMs = retentionSweepEnv.tickIntervalMs ?? 5 * 60 * 1000;
  const retentionIntervalMs = retentionSweepEnv.intervalMs ?? 24 * 60 * 60 * 1000;
  const retentionHookNote =
    retentionSweepEnv.tickIntervalMs !== undefined ||
    retentionSweepEnv.intervalMs !== undefined
      ? " [§10.7.3 test hooks active]"
      : "";
  console.log(
    `[start-runner] §10.7.3 retention-sweep scheduler started (tick=${retentionTickMs}ms, interval=${retentionIntervalMs}ms)${retentionHookNote}`
  );

  // §10.7.2 SV-PRIV-05 — tool residency metadata. Wired from the
  // operator-configured tools fixture when present (L-34 tools-registry
  // fixtures may declare `data_processing_location`). When Card's
  // `security.data_residency` is non-empty but no tool metadata is
  // provided, the residency guard rejects every invocation with
  // PermissionDenied(residency-violation, sub_reason=unknown-region)
  // per §10.7.2's primary-signal rule.
  const dataResidency = Array.isArray(card.security?.data_residency)
    ? card.security.data_residency
    : [];
  const toolResidencyLookup: (
    name: string
  ) => { declared_location?: readonly string[]; attested_location?: readonly string[] } | undefined =
    (_name) => {
      // Default lookup: no tool declares a location. Deployments wire
      // real metadata via a future registry extension. With empty
      // `dataResidency` the guard is inert; non-empty + unknown tool
      // → residency-violation (the spec's intended behavior).
      return undefined;
    };

  // Build the ResumeContext before startRunner so both the state-route
  // plugin (lazy-hydrate) and the post-boot scan share the same ctx.
  const cardVersionForResume =
    typeof (card as { version?: unknown }).version === "string"
      ? ((card as { version: string }).version)
      : "1.0";
  const toolPoolHashForResume = registry
    ? `sha256:registry-size-${registry.size()}`
    : "sha256:no-registry-loaded";
  const resumeCtx: ResumeContext = {
    currentCardVersion: cardVersionForResume,
    currentToolPoolHash: toolPoolHashForResume,
    toolCompensation: () => ({ canCompensate: false }),
    replayPending: async (_se: PersistedSideEffect) => null,
    compensate: async () => undefined,
    cardActiveMode: activeCapability,
    clock
  };

  const app = await startRunner({
    trust,
    card,
    alg: SIGNING_ALG as "EdDSA" | "ES256",
    kid: trust.publisher_kid,
    privateKey,
    x5c,
    ...(skipCardSchemaValidation ? { skipCardSchemaValidation: true } : {}),
    readiness: composeReadiness(
      // Finding AN / SV-CARD-10 — a Card that violates §10.3 three-axis
      // precedence pins /ready at 503 for the Runner's whole lifetime.
      // The ConfigPrecedenceViolation record is already in /logs/system/
      // recent under BOOT_SESSION_ID; operators flip /ready to 200 by
      // fixing the Card, not by poking the Runner.
      cardPrecedenceReadiness,
      // Finding AT — AGENTS.md §7.2/§7.3 violations pin /ready at 503
      // alongside the Config/AgentsMd*/error record under BOOT_SESSION_ID.
      agentsMdReadiness,
      // Finding AQ — revocation latch same semantic: /ready at 503 for
      // the remainder of the process once the revocation file is seen.
      bootstrapRevocationReadiness,
      boot,
      {
        // §10.5.1 unreachable-halt → /ready flips 503 audit-sink-unreachable.
        check: () => auditSink.readinessReason()
      },
      // Finding S / SV-MEM-03: /ready stays 503 memory-mcp-unavailable
      // until the §8.3 startup probe succeeds. Inert when no Memory MCP
      // was configured (markReady fires at probe construction above).
      memoryReadiness
    ),
    host: HOST,
    port: PORT,
    ...(registry
      ? {
          permissionsResolve: {
            registry,
            sessionStore,
            clock,
            activeCapability,
            ...(card.permissions?.toolRequirements !== undefined
              ? { toolRequirements: card.permissions.toolRequirements }
              : {}),
            ...(card.permissions?.policyEndpoint !== undefined
              ? { policyEndpoint: card.permissions.policyEndpoint }
              : {}),
            runnerVersion: "1.0"
          }
        }
      : {}),
    ...(BOOTSTRAP_BEARER
      ? {
          sessionsBootstrap: {
            sessionStore,
            clock,
            cardActiveMode: activeCapability,
            bootstrapBearer: BOOTSTRAP_BEARER,
            runnerVersion: "1.0",
            // §12.6 MUST — POST /sessions persists the file before 201.
            persister,
            toolPoolHash: registry
              ? `sha256:registry-size-${registry.size()}` // M3: real JCS hash
              : "sha256:no-registry-loaded",
            cardVersion:
              typeof (card as { version?: unknown }).version === "string"
                ? (card as { version: string }).version
                : "1.0",
            emitter: streamEmitter,
            agentName:
              typeof (card as { name?: unknown }).name === "string"
                ? ((card as { name: string }).name)
                : "soa-harness-runner",
            memoryStore,
            budgetTracker,
            ...(memoryClient !== undefined ? { memoryClient } : {}),
            ...(memoryDegradation !== undefined ? { memoryDegradation } : {}),
            systemLog,
            // Finding V + AA / SV-MEM-06 — §7.318 canonical key is
            // `sharing_policy`; legacy `default_sharing_scope` accepted
            // as fallback so pre-L-40 card fixtures still resolve.
            ...((): { memoryDefaultSharingScope?: "none" | "session" | "project" | "tenant" } => {
              const scope =
                card.memory?.sharing_policy ?? card.memory?.default_sharing_scope;
              return scope !== undefined ? { memoryDefaultSharingScope: scope } : {};
            })(),
            // Finding Q / SV-BUD-05 — stamp card.tokenBudget.billingTag on
            // every new session (record + persisted file + bearer scope).
            ...(typeof card.tokenBudget?.billingTag === "string"
              ? { cardBillingTag: card.tokenBudget.billingTag }
              : {}),
            // §19.4.1 SV-GOV-08 — advertise the Runner's supported Core
            // versions so the bootstrap path can reject empty-intersection
            // wire versions. Prefer the Card's declared set when present;
            // fall back to the Runner's built-in `["1.0"]`.
            ...(Array.isArray(card.supported_core_versions) &&
            card.supported_core_versions.length > 0
              ? { supportedCoreVersions: card.supported_core_versions }
              : {})
          }
        }
      : {}),
    auditTail: {
      chain,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    auditRecords: {
      chain,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    sessionState: {
      persister,
      sessionStore,
      clock,
      runnerVersion: "1.0",
      resumeCtx
    },
    budgetProjection: {
      sessionStore,
      clock,
      runnerVersion: "1.0",
      tracker: budgetTracker
    },
    eventsRecent: {
      emitter: streamEmitter,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    otelSpansRecent: {
      store: otelSpanStore,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    backpressureStatus: {
      state: backpressureState,
      sessionStore,
      clock,
      runnerVersion: "1.0",
      ...(BOOTSTRAP_BEARER !== undefined ? { bootstrapBearer: BOOTSTRAP_BEARER } : {})
    },
    systemLogRecent: {
      buffer: systemLog,
      sessionStore,
      clock,
      runnerVersion: "1.0",
      // Finding AN / AQ — when the Card fails §10.3 precedence OR the
      // bootstrap anchor is revoked at runtime, /ready is pinned at
      // 503 for the Runner's lifetime. The System Event Log is how
      // operators observe the record that explains the refusal, so
      // the endpoint bypasses readiness gating in those states (the
      // gate closure is a permanent terminal state, not a transient
      // one). A compliant Runner with no precedence failure + no
      // revocation re-asserts §14.5.4's readiness-gate contract.
      skipReadinessGate: !precedenceResult.ok ||
        bootstrapEnv.revocationFilePath !== undefined ||
        agentsMdValidationErr !== null
    },
    memoryState: {
      memoryStore,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    ...(registry
      ? {
          toolsRegistered: {
            registry,
            sessionStore,
            clock,
            runnerVersion: "1.0",
            registeredAt: clock()
          }
        }
      : {}),
    ...(registry
      ? {
          permissionsDecisions: {
            registry,
            sessionStore,
            chain,
            clock,
            activeCapability,
            // Finding AV / HR-07 — agentType pool filter with specific
            // denial reason.
            ...(typeof card.agentType === "string" ? { agentType: card.agentType } : {}),
            ...(card.permissions?.toolRequirements !== undefined
              ? { toolRequirements: card.permissions.toolRequirements }
              : {}),
            ...(card.permissions?.policyEndpoint !== undefined
              ? { policyEndpoint: card.permissions.policyEndpoint }
              : {}),
            ...(conformanceHandlerKey !== null
              ? {
                  resolvePdaVerifyKey: async (kid: string) =>
                    kid === "soa-conformance-test-handler-v1.0" ? conformanceHandlerKey : null
                }
              : {}),
            runnerVersion: "1.0",
            sink: auditSink,
            // §12.2 L-31 bracket-persist bundle.
            persister,
            markers,
            toolPoolHash: `sha256:registry-size-${registry.size()}`,
            cardVersion:
              typeof (card as { version?: unknown }).version === "string"
                ? (card as { version: string }).version
                : "1.0",
            emitter: streamEmitter,
            // §13.1 wire turn-accounting to the decision path so
            // /budget/projection advances per committed decision.
            budgetTracker,
            // §15 Finding N — share one tracker across the process.
            hookReentrancy,
            // §14.4 Finding W — OTel spans emitted at the decision
            // call-site, read back by /observability/otel-spans/recent.
            otelEmitter,
            // Finding AD / §13.3 — synthetic cache-hit injection.
            ...(syntheticCacheCfg.value !== undefined
              ? { syntheticCacheHit: syntheticCacheCfg.value }
              : {}),
            // §10.7.2 SV-PRIV-05 — residency layered-defence gate.
            ...(dataResidency.length > 0 ? { dataResidency } : {}),
            ...(dataResidency.length > 0 ? { toolResidency: toolResidencyLookup } : {}),
            // §15 hooks — operator supplies command lines via env.
            ...((): {
              hookConfig?: {
                preToolUseCommand?: readonly string[];
                postToolUseCommand?: readonly string[];
              };
            } => {
              const pre = process.env["SOA_PRE_TOOL_USE_HOOK"];
              const post = process.env["SOA_POST_TOOL_USE_HOOK"];
              if (!pre && !post) return {};
              const parse = (s: string | undefined): readonly string[] | undefined =>
                s && s.trim().length > 0 ? s.split(/\s+/) : undefined;
              const preCmd = parse(pre);
              const postCmd = parse(post);
              const hookConfig: {
                preToolUseCommand?: readonly string[];
                postToolUseCommand?: readonly string[];
              } = {};
              if (preCmd !== undefined) hookConfig.preToolUseCommand = preCmd;
              if (postCmd !== undefined) hookConfig.postToolUseCommand = postCmd;
              return { hookConfig };
            })()
          }
        }
      : {}),
    auditSinkEvents: {
      sink: auditSink,
      sessionStore,
      clock,
      runnerVersion: "1.0"
    },
    governance: {
      clock,
      runnerVersion: "1.0",
      ...(Array.isArray(card.supported_core_versions) &&
      card.supported_core_versions.length > 0
        ? { supportedCoreVersions: card.supported_core_versions }
        : {}),
      ...(errataBody !== undefined ? { errataBody } : {}),
      ...(docRoutes.length > 0 ? { docRoutes } : {})
    },
    privacy: {
      subjectStore,
      sessionStore,
      chain,
      clock,
      runnerVersion: "1.0",
      ...(BOOTSTRAP_BEARER !== undefined ? { operatorBearer: BOOTSTRAP_BEARER } : {}),
      emitter: streamEmitter,
      systemLog
    }
  });

  const addr = app.server.address();
  const bound = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
  console.log(`[start-runner] Runner live at ${bound}`);
  console.log(`  GET http://${HOST}:${PORT}/.well-known/agent-card.json`);
  console.log(`  GET http://${HOST}:${PORT}/.well-known/agent-card.jws`);
  console.log(`  GET http://${HOST}:${PORT}/health`);
  console.log(`  GET http://${HOST}:${PORT}/ready`);
  console.log(`  GET http://${HOST}:${PORT}/audit/tail`);
  console.log(`  GET http://${HOST}:${PORT}/audit/records?after=<id>&limit=<n>`);
  console.log(`  GET http://${HOST}:${PORT}/sessions/<session_id>/state`);
  console.log(`  GET http://${HOST}:${PORT}/audit/sink-events?after=<id>&limit=<n>`);
  console.log(`  GET http://${HOST}:${PORT}/budget/projection/<session_id>`);
  if (registry) console.log(`  GET http://${HOST}:${PORT}/tools/registered`);
  console.log(`  GET http://${HOST}:${PORT}/events/recent?session_id=<id>&after=<eid>&limit=<n>`);
  console.log(`  GET http://${HOST}:${PORT}/memory/state/<session_id>`);
  console.log(`  GET http://${HOST}:${PORT}/observability/otel-spans/recent?session_id=<id>&after=<span_id>&limit=<n>`);
  console.log(`  GET http://${HOST}:${PORT}/observability/backpressure`);
  console.log(`  GET http://${HOST}:${PORT}/logs/system/recent?session_id=<id>&category=<c1,c2>&after=<slog_id>&limit=<n>`);
  if (registry) {
    console.log(`  GET http://${HOST}:${PORT}/permissions/resolve?tool=<n>&session_id=<id>`);
    console.log(`  POST http://${HOST}:${PORT}/permissions/decisions`);
  }
  if (BOOTSTRAP_BEARER) console.log(`  POST http://${HOST}:${PORT}/sessions   (bootstrap bearer via SOA_RUNNER_BOOTSTRAP_BEARER)`);

  try {
    await boot.boot();
    console.log(`[start-runner] boot complete — /ready returning 200`);
  } catch (err) {
    console.error(`[start-runner] boot FAILED — /ready remains 503:`, err);
  }

  // L-29 Normative MUST #1 — post-boot / pre-listener resume scan.
  // Walk <sessionDir>, invoke resumeSession for every session whose
  // workflow.status is in {Planning, Executing, Optimizing, Handoff, Blocked}.
  // Outcomes are audited so operators see the recovery trail. Uses the
  // hoisted resumeCtx so lazy-hydrate sees the same card_version +
  // tool_pool_hash pins.
  try {
    const scanOutcomes = await scanAndResumeInProgressSessions({
      persister,
      resumeCtx,
      chain,
      log: (msg) => console.log(msg),
      clock
    });
    // §12.5 L-29 + SV-SESS-02: if any session file on disk is corrupt or
    // violates session.schema (including a bad workflow.status), the
    // Runner MUST NOT accept new traffic silently. Exit non-zero with the
    // closed-set reason so operators address the bad file before restart.
    if (scanHasHardFailure(scanOutcomes)) {
      const hits = scanOutcomes.filter(
        (o) => o.action === "failed-read" && o.detail !== undefined
      );
      console.error(
        `[start-runner] FATAL: boot scan detected ${hits.length} session file(s) with ` +
          `SessionFormatIncompatible — refusing to open listener.`
      );
      for (const h of hits) {
        console.error(
          `  session_id=${h.session_id} reason=${h.detail}`
        );
      }
      await app.close();
      process.exit(1);
    }
  } catch (err) {
    console.error(`[start-runner] L-29 boot scan FAILED (non-fatal; listener still opens):`, err);
  }

  // §11.3.1 start the dynamic-registration watcher after boot succeeds
  // so it can't trigger registration before the Tool Registry is loaded.
  let dynamicWatcher: { stop: () => Promise<void> } | null = null;
  if (DYNAMIC_REG_TRIGGER && registry) {
    dynamicWatcher = startDynamicRegistrationWatcher({
      triggerPath: DYNAMIC_REG_TRIGGER,
      registry,
      clock,
      pollIntervalMs: 250,
      log: (msg) => console.log(msg)
    });
    console.log(`[start-runner] dynamic-registration watcher on ${DYNAMIC_REG_TRIGGER}`);
  }

  const shutdown = async (sig: string) => {
    console.log(`[start-runner] received ${sig}, closing`);
    boot.stop();
    if (dynamicWatcher) await dynamicWatcher.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[start-runner] FATAL:", err);
  process.exit(1);
});
