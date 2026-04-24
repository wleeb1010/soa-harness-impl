#!/usr/bin/env node
// Demo entrypoint produced by create-soa-agent. Boots an in-process
// @soa-harness/memory-mcp-sqlite backend on :8001, then the Runner on
// :7700 configured against that backend, bootstraps a session, POSTs
// one permission decision to produce the first audit row, and stays up
// until Ctrl-C.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadInitialTrust,
  startRunner,
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  CrlCache,
  BootOrchestrator,
  InMemorySessionStore,
  loadToolRegistry,
  AuditChain
} from "@soa-harness/runner";
import { PINNED_SPEC_COMMIT } from "@soa-harness/schemas";
import {
  SqliteMemoryBackend,
  buildSqliteServer
} from "@soa-harness/memory-mcp-sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_BEARER =
  process.env.SOA_RUNNER_BOOTSTRAP_BEARER ?? "demo-bootstrap-bearer-replace-me";
const PORT = Number.parseInt(process.env.PORT ?? "7700", 10);
const MEMORY_PORT = Number.parseInt(process.env.SOA_MEMORY_MCP_PORT ?? "8001", 10);
const MEMORY_ENDPOINT =
  process.env.SOA_MEMORY_MCP_ENDPOINT ?? `http://127.0.0.1:${MEMORY_PORT}`;

async function startMemoryMcp() {
  const backend = new SqliteMemoryBackend({
    dbPath: process.env.SOA_MEMORY_MCP_SQLITE_DB ?? ":memory:"
  });
  const app = await buildSqliteServer({ backend });
  await app.listen({ host: "127.0.0.1", port: MEMORY_PORT });
  console.log(`[demo] memory-mcp-sqlite up at http://127.0.0.1:${MEMORY_PORT}`);
  return { app, backend };
}

async function main() {
  const memory = await startMemoryMcp();
  const trust = loadInitialTrust({ path: join(HERE, "initial-trust.json") });
  const card = JSON.parse(readFileSync(join(HERE, "agent-card.json"), "utf8"));
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({
    keys,
    subject: `CN=${trust.publisher_kid},O=create-soa-agent-demo`
  });
  const registry = loadToolRegistry(join(HERE, "tools.json"));
  const chain = new AuditChain(() => new Date());

  const crl = new CrlCache({
    fetcher: async (anchorUri) => ({
      issuer: `CN=demo for ${anchorUri}`,
      issued_at: new Date().toISOString(),
      not_after: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      revoked_kids: []
    })
  });
  const anchors = card.security?.trustAnchors ?? [];
  const boot = new BootOrchestrator({ anchors, crl });
  const sessionStore = new InMemorySessionStore();

  process.env.SOA_RUNNER_MEMORY_MCP_ENDPOINT = MEMORY_ENDPOINT;
  const app = await startRunner({
    trust,
    card,
    alg: "EdDSA",
    kid: trust.publisher_kid,
    privateKey: keys.privateKey,
    x5c: [cert],
    readiness: boot,
    host: "127.0.0.1",
    port: PORT,
    governance: {
      clock: () => new Date(),
      pinnedSpecCommit: PINNED_SPEC_COMMIT,
      runnerVersion: "1.2"
    },
    permissionsResolve: {
      registry,
      sessionStore,
      clock: () => new Date(),
      activeCapability: card.permissions?.activeMode ?? "ReadOnly",
      runnerVersion: "1.2"
    },
    sessionsBootstrap: {
      sessionStore,
      clock: () => new Date(),
      cardActiveMode: card.permissions?.activeMode ?? "ReadOnly",
      bootstrapBearer: BOOTSTRAP_BEARER,
      runnerVersion: "1.2"
    },
    auditTail: { chain, sessionStore, clock: () => new Date(), runnerVersion: "1.2" },
    auditRecords: { chain, sessionStore, clock: () => new Date(), runnerVersion: "1.2" },
    permissionsDecisions: {
      registry,
      sessionStore,
      chain,
      clock: () => new Date(),
      activeCapability: card.permissions?.activeMode ?? "ReadOnly",
      runnerVersion: "1.2"
    }
  });

  await boot.boot();

  // Drive one permission decision so /audit/tail reflects record_count:1.
  const bootstrapRes = await fetch(`http://127.0.0.1:${PORT}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
    body: JSON.stringify({
      requested_activeMode: card.permissions?.activeMode ?? "ReadOnly",
      user_sub: "demo-user",
      request_decide_scope: true
    })
  });
  if (!bootstrapRes.ok) {
    throw new Error(`demo: POST /sessions ${bootstrapRes.status}`);
  }
  const session = await bootstrapRes.json();
  const body = JSON.parse(readFileSync(join(HERE, "permission-decisions", "auto-allow.json"), "utf8"));
  body.session_id = session.session_id;
  const decRes = await fetch(`http://127.0.0.1:${PORT}/permissions/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.session_bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!decRes.ok) {
    throw new Error(`demo: POST /permissions/decisions ${decRes.status}`);
  }
  const decision = await decRes.json();
  console.log(
    `[demo] first audit row produced: ${decision.audit_record_id} (${decision.decision}); ` +
      `session=${session.session_id}`
  );
  console.log(`[demo] Runner live at http://127.0.0.1:${PORT} — Ctrl-C to stop`);

  const shutdown = async (sig) => {
    console.log(`[demo] received ${sig}; closing`);
    await app.close();
    await memory.app.close();
    memory.backend.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[demo] FATAL:", err);
  process.exit(1);
});
