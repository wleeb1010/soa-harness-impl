import { readFileSync, existsSync } from "node:fs";
import { importPKCS8, type CryptoKey, type KeyObject } from "jose";
import { loadInitialTrust } from "../bootstrap/index.js";
import { startRunner } from "../server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../card/cert.js";
import { loadConformanceCard } from "../card/conformance-loader.js";
import { createClock } from "../clock/index.js";
import { CrlCache, type Crl, type CrlFetcher } from "../crl/index.js";
import { BootOrchestrator } from "../boot/index.js";
import { InMemorySessionStore, type Capability } from "../permission/index.js";
import { loadToolRegistry } from "../registry/index.js";
import { AuditChain } from "../audit/index.js";
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
  const clock = createClock({
    envClock: process.env.RUNNER_TEST_CLOCK,
    nodeEnv: process.env.NODE_ENV,
    tlsEnabled: false,
    host: HOST
  });

  const trust = loadInitialTrust({ path: TRUST_PATH, now: clock() });
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
    sessionStore.register(sid, bearer, { activeMode });
    console.log(`[start-runner] pre-registered demo session ${sid} (activeMode=${activeMode})`);
  }

  const registryPath = TOOLS_FIXTURE ?? TOOLS_PATH ?? (existsSync("./tools.json") ? "./tools.json" : undefined);
  const registry = registryPath ? loadToolRegistry(registryPath) : undefined;
  if (registry) {
    const label = TOOLS_FIXTURE ? "conformance fixture" : "operator registry";
    console.log(`[start-runner] loaded ${registry.size()} tool(s) from ${label}: ${registryPath}`);
  }

  const chain = new AuditChain(clock);
  const activeCapability = (card.permissions?.activeMode ?? "ReadOnly") as Capability;

  const app = await startRunner({
    trust,
    card,
    alg: SIGNING_ALG as "EdDSA" | "ES256",
    kid: trust.publisher_kid,
    privateKey,
    x5c,
    ...(skipCardSchemaValidation ? { skipCardSchemaValidation: true } : {}),
    readiness: boot,
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
            runnerVersion: "1.0"
          }
        }
      : {}),
    auditTail: {
      chain,
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
  if (registry) console.log(`  GET http://${HOST}:${PORT}/permissions/resolve?tool=<n>&session_id=<id>`);
  if (BOOTSTRAP_BEARER) console.log(`  POST http://${HOST}:${PORT}/sessions   (bootstrap bearer via SOA_RUNNER_BOOTSTRAP_BEARER)`);

  try {
    await boot.boot();
    console.log(`[start-runner] boot complete — /ready returning 200`);
  } catch (err) {
    console.error(`[start-runner] boot FAILED — /ready remains 503:`, err);
  }

  const shutdown = async (sig: string) => {
    console.log(`[start-runner] received ${sig}, closing`);
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
