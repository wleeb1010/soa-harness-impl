import { readFileSync } from "node:fs";
import { importPKCS8, type CryptoKey, type KeyObject } from "jose";
import { loadInitialTrust } from "../bootstrap/index.js";
import { startRunner } from "../server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../card/cert.js";

const TRUST_PATH = process.env.RUNNER_TRUST_PATH ?? "./initial-trust.json";
const CARD_PATH = process.env.RUNNER_CARD_PATH ?? "./agent-card.json";
const PORT = Number.parseInt(process.env.RUNNER_PORT ?? "7700", 10);
const HOST = process.env.RUNNER_HOST ?? "0.0.0.0";
const SIGNING_KEY_PATH = process.env.RUNNER_SIGNING_KEY;
const SIGNING_ALG = (process.env.RUNNER_SIGNING_ALG as "EdDSA" | "ES256" | undefined) ?? "EdDSA";
const CERT_CHAIN_PATH = process.env.RUNNER_X5C;

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
    throw new Error(
      "RUNNER_SIGNING_KEY and RUNNER_X5C must be set together; a key without its cert chain is not servable."
    );
  }

  if (SIGNING_ALG !== "EdDSA") {
    throw new Error(
      `Ephemeral-key demo mode only supports EdDSA, got SIGNING_ALG=${SIGNING_ALG}. Supply RUNNER_SIGNING_KEY + RUNNER_X5C for other algorithms.`
    );
  }

  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({
    keys,
    subject: `CN=${kid},O=SOA-Harness-Demo`
  });
  console.warn(
    "[start-runner] WARNING: no RUNNER_SIGNING_KEY / RUNNER_X5C set — generated an ephemeral Ed25519 " +
      "keypair + self-signed cert in memory. Self-signed leaves do NOT chain to any trust anchor; " +
      "this is acceptable for local smoke only. Production: operator-issued chain anchored in " +
      "security.trustAnchors per Core §6.1.1."
  );
  return { privateKey: keys.privateKey, x5c: [cert] };
}

async function main() {
  const trust = loadInitialTrust({ path: TRUST_PATH });
  const card: unknown = JSON.parse(readFileSync(CARD_PATH, "utf8"));
  const { privateKey, x5c } = await resolveKeyAndX5c(trust.publisher_kid);

  const app = await startRunner({
    trust,
    card,
    alg: SIGNING_ALG,
    kid: trust.publisher_kid,
    privateKey,
    x5c,
    host: HOST,
    port: PORT
  });

  const addr = app.server.address();
  const bound = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
  console.log(`[start-runner] Agent Card endpoint live at ${bound}`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.json`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.jws`);

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
