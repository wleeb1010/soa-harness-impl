#!/usr/bin/env node
/**
 * `soa-langgraph-adapter-demo` — Phase 2.7 bin.
 *
 * Self-contained demo binary that stands up the two-Runner composition
 * proven in Phase 2.6: a minimal back-end Runner on an internal random
 * port, plus the LangGraph adapter server exposing the §5 Required
 * Stack surface on a caller-configurable port.
 *
 * Validator handoff:
 *   SOA_ADAPTER_URL=http://127.0.0.1:${ADAPTER_PORT}
 *   soa-validate --adapter=langgraph --impl-url $SOA_ADAPTER_URL
 *
 * Environment variables:
 *   PORT                       TCP port the adapter listens on (default 7701).
 *   HOST                       Bind host (default 127.0.0.1).
 *   ADAPTER_SESSION_ID         Session id for the default registered session.
 *                              Must match /^ses_[A-Za-z0-9]{16,}$/ per §14.5.5.
 *                              (default "ses_adapterdemo0000001")
 *   ADAPTER_SESSION_BEARER     Bearer for the default session (default
 *                              "adapter-demo-session-bearer").
 *   ADAPTER_ACTIVE_MODE        Capability for the default session
 *                              (ReadOnly | WorkspaceWrite | DangerFullAccess);
 *                              drives retention_class stamping downstream.
 *
 * Shutdown: SIGINT / SIGTERM gracefully close both servers.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startDemoBackEnd } from "../demo-back-end.js";
import { startLangGraphAdapterRunner } from "../server.js";
import { ADAPTER_VERSION } from "../index.js";
import type { Capability } from "@soa-harness/runner";

const TRUST = {
  soaHarnessVersion: "1.0" as const,
  publisher_kid: "soa-release-v1.0",
  spki_sha256: "0".repeat(64),
  issuer: "CN=SOA-Harness Adapter Demo CA",
  issued_at: new Date().toISOString(),
  channel: "sdk-pinned" as const,
};

const DEFAULT_CARD: Record<string, unknown> = {
  soaHarnessVersion: "1.0",
  name: "langgraph-adapter-demo",
  version: ADAPTER_VERSION,
  description: "SOA-Harness LangGraph adapter demo — self-contained binary spinning up a minimal back-end Runner + adapter surface for validator probing.",
  url: "https://runner.local.adapter-demo",
  protocolVersion: "a2a-0.3",
  agentType: "general-purpose",
  permissions: { activeMode: "ReadOnly", handler: "Interactive" },
  security: {
    oauthScopes: [],
    trustAnchors: [
      {
        issuer: "CN=SOA-Harness Adapter Demo CA",
        spki_sha256: "0".repeat(64),
        uri: "https://ca.local.adapter-demo/",
        publisher_kid: "soa-release-v1.0",
      },
    ],
  },
};

const VALID_ACTIVE_MODES: ReadonlySet<Capability> = new Set<Capability>([
  "ReadOnly",
  "WorkspaceWrite",
  "DangerFullAccess",
]);

function parseActiveMode(v: string | undefined): Capability {
  if (!v) return "ReadOnly";
  if (VALID_ACTIVE_MODES.has(v as Capability)) return v as Capability;
  throw new Error(
    `ADAPTER_ACTIVE_MODE=${v} is not in {ReadOnly, WorkspaceWrite, DangerFullAccess}`,
  );
}

export interface StartAdapterDemoOptions {
  port?: number;
  host?: string;
  sessionId?: string;
  sessionBearer?: string;
  activeMode?: Capability;
  /**
   * When true (default), the adapter exposes GET /debug/backend-info
   * for validator discovery. Loopback-only; request-time gate rejects
   * non-loopback callers with 403. Set to false (via
   * SOA_ADAPTER_DEMO_MODE=0) to skip route registration for
   * defense-in-depth in sensitive environments.
   */
  demoMode?: boolean;
}

export interface AdapterDemoRunning {
  adapterUrl: string;
  backEndUrl: string;
  publisherKid: string;
  sessionId: string;
  sessionBearer: string;
  close(): Promise<void>;
}

export async function startAdapterDemo(
  opts: StartAdapterDemoOptions = {},
): Promise<AdapterDemoRunning> {
  const backEnd = await startDemoBackEnd({ host: "127.0.0.1", port: 0 });

  const sessionId = opts.sessionId ?? "ses_adapterdemo0000001";
  const sessionBearer = opts.sessionBearer ?? "adapter-demo-session-bearer";
  const activeMode = opts.activeMode ?? "ReadOnly";
  const demoMode = opts.demoMode ?? true;

  const adapter = await startLangGraphAdapterRunner({
    baseCard: DEFAULT_CARD,
    adapterVersion: ADAPTER_VERSION,
    trust: TRUST,
    port: opts.port ?? 7701,
    host: opts.host ?? "127.0.0.1",
    events: {
      sessionId,
      sessionBearer,
      activeMode,
    },
    ...(demoMode
      ? {
          debug: {
            backendUrl: backEnd.url,
            adminReadBearer: backEnd.bearer,
          },
        }
      : {}),
  });

  const publisherKid = "soa-langgraph-adapter-demo";

  return {
    adapterUrl: `http://${adapter.address.host}:${adapter.address.port}`,
    backEndUrl: backEnd.url,
    publisherKid,
    sessionId,
    sessionBearer,
    async close() {
      await adapter.close();
      await backEnd.close();
    },
  };
}

async function main(): Promise<void> {
  const port = process.env["PORT"] ? Number.parseInt(process.env["PORT"], 10) : 7701;
  const host = process.env["HOST"] ?? "127.0.0.1";
  const sessionId = process.env["ADAPTER_SESSION_ID"] ?? "ses_adapterdemo0000001";
  const sessionBearer = process.env["ADAPTER_SESSION_BEARER"] ?? "adapter-demo-session-bearer";
  const activeMode = parseActiveMode(process.env["ADAPTER_ACTIVE_MODE"]);
  // SOA_ADAPTER_DEMO_MODE defaults to on; explicit "0" disables the
  // /debug/backend-info discovery route.
  const demoMode = process.env["SOA_ADAPTER_DEMO_MODE"] !== "0";

  const running = await startAdapterDemo({
    port,
    host,
    sessionId,
    sessionBearer,
    activeMode,
    demoMode,
  });

  // Human-readable startup banner.
   
  console.log(`[adapter-demo] adapter listening at ${running.adapterUrl}`);
   
  console.log(`[adapter-demo] back-end Runner at ${running.backEndUrl}`);
   
  console.log(`[adapter-demo] publisher_kid: ${running.publisherKid}`);
   
  console.log(`[adapter-demo] session_id: ${running.sessionId}`);
   
  console.log(`[adapter-demo] session_bearer: ${sessionBearer}`);
   
  console.log(
    "[adapter-demo] validator: soa-validate --adapter=langgraph --impl-url " +
      running.adapterUrl,
  );
  if (demoMode) {
     
    console.log(`[adapter-demo] /debug/backend-info enabled (SOA_ADAPTER_DEMO_MODE=1)`);
  }

  // Phase 2.8 — deterministic machine-parseable line. Distinct prefix
  // from the human-readable `[adapter-demo]` banner so test harnesses
  // can regex `^\[soa-adapter-demo\] backend_url=(.*)$` without
  // false-positives against the prose lines above.
   
  console.log(`[soa-adapter-demo] backend_url=${running.backEndUrl}`);

  async function shutdown(signal: string) {
     
    console.log(`[adapter-demo] ${signal} received, shutting down`);
    await running.close();
    process.exit(0);
  }
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

/**
 * Invoked-as-CLI guard. `process.argv[1]` on Linux commonly points at a
 * symlink under `node_modules/.bin/`; resolving the symlink first prevents
 * the silent-exit bug caught in create-soa-agent@1.0.0-rc.2 (commit
 * a404c7c) where the guard spuriously failed on symlinked invocations.
 */
const invokedAsCli =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  main().catch((err: unknown) => {
     
    console.error("[adapter-demo] FATAL:", err);
    process.exit(1);
  });
}
