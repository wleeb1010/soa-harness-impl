import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { importPKCS8, type CryptoKey, type KeyObject } from "jose";
import { loadInitialTrust } from "../bootstrap/index.js";
import { startRunner } from "../server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../card/cert.js";
import { loadConformanceCard } from "../card/conformance-loader.js";
import { createClock } from "../clock/index.js";
import { CrlCache, type Crl, type CrlFetcher } from "../crl/index.js";
import { BootOrchestrator } from "../boot/index.js";
import { InMemorySessionStore, type Capability } from "../permission/index.js";
import { loadToolRegistry, ToolPoolStale } from "../registry/index.js";
import {
  AuditChain,
  AuditSink,
  parseAuditSinkFailureModeEnv,
  assertAuditSinkEnvListenerSafe
} from "../audit/index.js";
import {
  SessionPersister,
  scanAndResumeInProgressSessions,
  type ResumeContext,
  type PersistedSideEffect
} from "../session/index.js";
import { composeReadiness } from "../probes/index.js";
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
  security?: { trustAnchors?: TrustAnchor[] };
  permissions?: { activeMode?: Capability; toolRequirements?: Record<string, Control>; policyEndpoint?: string };
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

  // §12.5.3 crash-test marker emission + production guard.
  const markersEnabled = parseCrashTestMarkersEnv(process.env.RUNNER_CRASH_TEST_MARKERS);
  assertCrashTestMarkersListenerSafe({ enabled: markersEnabled, host: HOST });
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
  const trust = loadInitialTrust({
    path: trustPath,
    now: clock(),
    ...(expectedPublisherKid !== undefined ? { expectedPublisherKid } : {})
  });
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
      registry = loadToolRegistry(registryPath);
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

  const app = await startRunner({
    trust,
    card,
    alg: SIGNING_ALG as "EdDSA" | "ES256",
    kid: trust.publisher_kid,
    privateKey,
    x5c,
    ...(skipCardSchemaValidation ? { skipCardSchemaValidation: true } : {}),
    readiness: composeReadiness(boot, {
      // §10.5.1 unreachable-halt → /ready flips 503 audit-sink-unreachable.
      check: () => auditSink.readinessReason()
    }),
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
                : "1.0"
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
      runnerVersion: "1.0"
    },
    ...(registry
      ? {
          permissionsDecisions: {
            registry,
            sessionStore,
            chain,
            clock,
            activeCapability,
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
            sink: auditSink
          }
        }
      : {}),
    auditSinkEvents: {
      sink: auditSink,
      sessionStore,
      clock,
      runnerVersion: "1.0"
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
  // Outcomes are audited so operators see the recovery trail.
  //
  // The bin's scan uses a no-op replay/compensate context — the §10.3-driven
  // tool-invocation layer lands in M3. A quiescent session (no pending/inflight
  // side_effects) passes through step 4 cleanly; a session with real in-flight
  // work gets its phase advanced via the noop replay (caller responsibility to
  // supply real replay fns once M3 tool dispatch wires in).
  const cardVersion =
    typeof (card as { version?: unknown }).version === "string"
      ? ((card as { version: string }).version)
      : "1.0";
  const toolPoolHash = registry
    ? `sha256:registry-size-${registry.size()}` // M3 computes real JCS hash
    : "sha256:no-registry-loaded";
  const resumeCtx: ResumeContext = {
    currentCardVersion: cardVersion,
    currentToolPoolHash: toolPoolHash,
    toolCompensation: () => ({ canCompensate: false }),
    replayPending: async (_se: PersistedSideEffect) => null,
    compensate: async () => undefined,
    cardActiveMode: activeCapability,
    clock
  };
  try {
    await scanAndResumeInProgressSessions({
      persister,
      resumeCtx,
      chain,
      log: (msg) => console.log(msg),
      clock
    });
  } catch (err) {
    console.error(`[start-runner] L-29 boot scan FAILED (non-fatal; listener still opens):`, err);
  }

  const shutdown = async (sig: string) => {
    console.log(`[start-runner] received ${sig}, closing`);
    boot.stop();
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
