import { readFileSync } from "node:fs";
import { generateKeyPair, importPKCS8 } from "jose";
import { loadInitialTrust } from "../bootstrap/index.js";
import { startRunner } from "../server.js";

const TRUST_PATH = process.env.RUNNER_TRUST_PATH ?? "./initial-trust.json";
const CARD_PATH = process.env.RUNNER_CARD_PATH ?? "./agent-card.json";
const PORT = Number.parseInt(process.env.RUNNER_PORT ?? "7700", 10);
const HOST = process.env.RUNNER_HOST ?? "0.0.0.0";
const SIGNING_KEY_PATH = process.env.RUNNER_SIGNING_KEY;
const SIGNING_ALG = (process.env.RUNNER_SIGNING_ALG as "EdDSA" | "ES256" | undefined) ?? "EdDSA";

async function resolvePrivateKey() {
  if (SIGNING_KEY_PATH) {
    const pem = readFileSync(SIGNING_KEY_PATH, "utf8");
    return importPKCS8(pem, SIGNING_ALG);
  }
  const { privateKey } = await generateKeyPair(SIGNING_ALG);
  console.warn(
    "[start-runner] WARNING: no RUNNER_SIGNING_KEY set — generated an ephemeral EdDSA keypair in memory. " +
      "This is acceptable for local smoke only. Production keys come from the software keystore (Week 6)."
  );
  return privateKey;
}

async function main() {
  const trust = loadInitialTrust({ path: TRUST_PATH });
  const card: unknown = JSON.parse(readFileSync(CARD_PATH, "utf8"));
  const privateKey = await resolvePrivateKey();

  const app = await startRunner({
    trust,
    card,
    alg: SIGNING_ALG,
    kid: trust.publisher_kid,
    privateKey,
    host: HOST,
    port: PORT
  });

  const addr = app.server.address();
  const bound = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
  console.log(`[start-runner] Agent Card endpoint live at ${bound}`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.json`);
  console.log(`[start-runner]   GET http://${HOST}:${PORT}/.well-known/agent-card.json.jws`);

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
