import { readFileSync, existsSync } from "node:fs";
import { importPKCS8, type CryptoKey, type KeyObject } from "jose";
import { loadInitialTrust } from "../bootstrap/index.js";
import { startRunner } from "../server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../card/cert.js";
import { createClock } from "../clock/index.js";
import { CrlCache, type Crl, type CrlFetcher } from "../crl/index.js";
import { BootOrchestrator } from "../boot/index.js";
import { InMemorySessionStore, type Capability } from "../permission/index.js";
import { loadToolRegistry } from "../registry/index.js";
import type { TrustAnchor } from "../card/verify.js";
import type { Control } from "../registry/index.js";

const TRUST_PATH = process.env.RUNNER_TRUST_PATH ?? "./initial-trust.json";
const CARD_PATH = process.env.RUNNER_CARD_PATH ?? "./agent-card.json";
const TOOLS_PATH = process.env.RUNNER_TOOLS_PATH;
const PORT = Number.parseInt(process.env.RUNNER_PORT ?? "7700", 10);
const HOST = process.env.RUNNER_HOST ?? "0.0.0.0";
const SIGNING_KEY_PATH = process.env.RUNNER_SIGNING_KEY;
const SIGNING_ALG = (process.env.RUNNER_SIGNING_ALG as "EdDSA" | "ES256" | undefined) ?? "EdDSA";
const CERT_CHAIN_PATH = process.env.RUNNER_X5C;
const DEMO_MODE = process.env.RUNNER_DEMO_MODE === "1";
const DEMO_SESSION_SPEC = process.env.RUNNER_DEMO_SESSION; // "<session_id>:<bearer>"

function pemCertChainToX5c(pem: string): string[] {
  const matches = pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g);
  const out: string[] = [];
  for (const match of matches) {
    const body = match[1];
    if (!body) continue;
    out.push(body.replace(/\s+/g, ""));
  }
  if (out.length === 0) {
    throw new Error(`RUNNER_X5C=${CERT_CHAIN_PATH} contained no PEM certificates`);
  }
  return out;
}

async function resolveKeyAndX5c(
  kid: string
): Promise<{ privateKey: CryptoKey | KeyObject | Uint8Array; x5c: string[] }> {
  if (SIGNING_KEY_PATH && CERT_CHAIN_PATH) {
    const pem = readFileSync(SIGNING_KEY_PATH, "utf8");
    const privateKey = await importPKCS8(pem, SIGNING_ALG);
    const x5c = pemCertChainToX5c(readFileSync(CERT_CHAIN_PATH, "utf8"));
    return { privateKey, x5c };
  }

  if (SIGNING_KEY_PATH || CERT_CHAIN_PATH) {
    throw new Error("RUNNER_SIGNING_KEY and RUNNER_X5C must be set together.");
  }
  if (SIGNING_ALG !== "EdDSA") {
    throw new Error(`Ephemeral-key demo only supports EdDSA, got ${SIGNING_ALG}.`);
  }
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${kid},O=SOA-Harness-Demo` });
  console.warn(
    "[start-runner] WARNING: no RUNNER_SIGNING_KEY / RUNNER_X5C — generated an ephemeral Ed25519 " +
      "keypair + self-signed cert. Production: operator-issued chain anchored in trustAnchors."
  );
  return { privateKey: keys.privateKey, x5c: [cert] };
}

function demoCrlFetcher(now: () => Date): CrlFetcher {
  return async (anchorUri) => {
    const issuedAt = now();
    const notAfter = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
    const crl: Crl = {
      issuer: `CN=Demo CA for ${anchorUri}`,
      issued_at: issuedAt.toISOString(),
      not_after: notAfter.toISOString(),
      revoked_kids: []
    };
    return crl;
  };
}

interface CardPermissions {
  activeMode?: Capability;
  toolRequirements?: Record<string, Control>;
  policyEndpoint?: string;
}
interface CardShape {
  security?: { trustAnchors?: TrustAnchor[] };
  permissions?: CardPermissions;
}

async function main() {
  const clock = createClock({
    envClock: process.env.RUNNER_TEST_CLOCK,
    nodeEnv: process.env.NODE_ENV,
    tlsEnabled: false,
    host: HOST
  });

  const trust = loadInitialTrust({ path: TRUST_PATH, now: clock() });
  const card = JSON.parse(readFileSync(CARD_PATH, "utf8")) as CardShape;
  const anchors = card.security?.trustAnchors ?? [];
  const { privateKey, x5c } = await resolveKeyAndX5c(trust.publisher_kid);

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
    const [sid, bearer] = DEMO_SESSION_SPEC.split(":", 2);
    if (!sid || !bearer) {
      throw new Error(`RUNNER_DEMO_SESSION must be "<session_id>:<bearer>", got "${DEMO_SESSION_SPEC}"`);
    }
    sessionStore.register(sid, bearer);
    console.log(`[start-runner] pre-registered demo session ${sid}`);
  }

  const toolsPath = TOOLS_PATH ?? (existsSync("./tools.json") ? "./tools.json" : undefined);
  const registry = toolsPath ? loadToolRegistry(toolsPath) : undefined;

  const activeCapability = (card.permissions?.activeMode ?? "ReadOnly") as Capability;

  const buildOpts = {
    trust,
    card,
    alg: SIGNING_ALG as "EdDSA" | "ES256",
    kid: trust.publisher_kid,
    privateKey,
    x5c,
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
      : {})
  };
  const app = await startRunner(buildOpts);

  const addr = app.server.address();
  const bound = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
  console.log(`[start-runner] Agent Card endpoint live at ${bound}`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.json`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.jws`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/health`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/ready  (503 until boot completes)`);
  if (registry) {
    console.log(`[start-runner]   GET http://${HOST}:${PORT}/permissions/resolve?tool=<name>&session_id=<id>`);
    console.log(`[start-runner]     (${registry.size()} tool(s) registered)`);
  }

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
