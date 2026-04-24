/**
 * HTTP compose-and-serve — Phase 2.5.
 *
 * Brings up a Fastify server exposing the §5 Required Stack surface
 * (agent-card JSON + detached JWS, health, ready) populated with an
 * adapter-flavored Agent Card whose `adapter_notes.host_framework`
 * equals "langgraph". Built by reusing @soa-harness/runner's
 * `buildRunnerApp` with an overlaid card — no fork of the Runner
 * HTTP stack.
 *
 * Scope (Phase 2.5): the minimum HTTP surface required for
 * `soa-validate --agent-url <adapter> --adapter=langgraph` to hit
 * SV-ADAPTER-01 (CardInjection) + baseline §5 conformance.
 *
 * Out of scope (Phase 2.6+):
 *   - /events/recent populated from the adapter's EventMapper output
 *     (requires wiring the graph-execution event source into the
 *     Runner's StreamEvent channel).
 *   - /audit/records chain-integrity surface (the adapter forwards
 *     rows UPSTREAM to a back-end Runner via audit-sink.ts; the
 *     adapter's own HTTP doesn't serve the upstream's chain).
 *   - Live tool-dispatch driver that feeds LangGraph invocations
 *     through the adapter.toolNode so /permissions/decisions round-trips
 *     against the back-end Runner land in the ambient test harness.
 */

import {
  buildRunnerApp,
  generateEd25519KeyPair,
  generateSelfSignedEd25519Cert,
  InMemorySessionStore,
  StreamEventEmitter,
  type InitialTrust,
  type Capability,
} from "@soa-harness/runner";
import { webcrypto } from "node:crypto";
import { buildAdapterCard, type BuildAdapterCardOptions } from "./agent-card.js";
import { EventBridge } from "./event-bridge.js";

/**
 * Structural re-type of the shape returned by `buildRunnerApp` — avoids
 * forcing consumers of `@soa-harness/langgraph-adapter` to install
 * `fastify` as a direct dependency. Methods used by the adapter server
 * are a small subset of the full FastifyInstance surface; we declare
 * only those.
 */
export interface AdapterFastifyApp {
  listen(args: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
  server: { address(): { port: number } | string | null };
  inject(args: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, string | string[] | number | undefined>;
  }>;
}

export interface StartLangGraphAdapterRunnerOptions {
  /** Base Agent Card body (loaded from a file or constructed in code). */
  baseCard: Record<string, unknown>;
  /** Adapter package version (matches ADAPTER_VERSION export). */
  adapterVersion: string;
  /**
   * Initial trust record per §5.3 External Bootstrap Root. In tests a
   * self-signed / placeholder-spki fixture is acceptable; production
   * deployments supply operator-issued trust via `loadInitialTrust`.
   */
  trust: InitialTrust;
  /**
   * Card-signing keypair + cert chain. When omitted, the server
   * generates a fresh Ed25519 keypair + self-signed cert — ONLY
   * suitable for loopback / test fixtures. Production callers MUST
   * pass operator-issued `privateKey` + `x5c` and NOT rely on the
   * synthesized demo key.
   */
  signing?: {
    alg: "EdDSA";
    kid: string;
    privateKey: unknown;
    x5c: string[];
  };
  /** TCP port to listen on. Default 7700. Use 0 to bind an OS-assigned port. */
  port?: number;
  /** Bind host. Default "127.0.0.1" (loopback). */
  host?: string;
  /** Optional forward-facing adapter_notes overrides (deferrals, deviations). */
  adapterNotesOverrides?: Omit<BuildAdapterCardOptions, "baseCard" | "adapterVersion">;
  /**
   * When present, the adapter server additionally serves /events/recent
   * populated by a `StreamEventEmitter` the test / orchestrator drives.
   * A default session is auto-registered in an in-memory session store
   * with the supplied bearer so caller-authenticated GET /events/recent
   * works out of the box.
   *
   * Omit to skip event-surface wiring (Phase 2.5 default — card only).
   */
  events?: {
    /** Session ID the emitter is scoped under. */
    sessionId: string;
    /** Bearer token for the default session — used in sessions:read:<sid> or admin:read headers. */
    sessionBearer: string;
    /** activeMode for the default session (affects retention_class stamping downstream). Default: "ReadOnly". */
    activeMode?: Capability;
  };
  /**
   * When present, the adapter exposes GET /debug/backend-info so
   * validators + demo-mode orchestrators can discover the back-end
   * Runner URL (and optional admin:read bearer) the adapter was
   * composed against.
   *
   * Construction-time gate: caller decides whether the route exists
   * (demo binary passes this only when SOA_ADAPTER_DEMO_MODE!=0).
   * Request-time gate: the handler rejects non-loopback callers with
   * 403 regardless of the overall host/port the adapter is bound to
   * — protecting against the case where an operator accidentally
   * binds the adapter to a non-loopback address in demo mode.
   *
   * MUST NOT be wired in production deployments.
   */
  debug?: {
    backendUrl: string;
    /** Optional admin-read bearer against the back-end. null when not known. */
    adminReadBearer?: string | null;
  };
}

export interface LangGraphAdapterServer {
  /** Underlying HTTP app — exposed for .inject()-driven tests + custom route registration. Structurally typed to avoid a hard fastify peer-dep. */
  app: AdapterFastifyApp;
  /** TCP address the server is bound to (host + port). Populated after listen(). */
  address: { host: string; port: number };
  /** The agent card actually served (already includes adapter_notes). */
  agentCard: Record<string, unknown>;
  /**
   * Event-surface handles — present iff `opts.events` was passed. The
   * bridge gives tests a direct way to push LangGraph events into the
   * emitter without spinning up a live StateGraph; /events/recent reads
   * from the same emitter.
   */
  events?: {
    emitter: StreamEventEmitter;
    bridge: EventBridge;
    sessionId: string;
    sessionBearer: string;
  };
  /** Graceful shutdown — closes the listening socket + Fastify. */
  close(): Promise<void>;
}

const DEMO_WARNING =
  "[langgraph-adapter/server] WARNING: generated a synthetic Ed25519 keypair + self-signed cert for local demo use only. " +
  "The private key was NOT persisted; production deployments MUST pass operator-issued signing credentials via opts.signing.";

async function synthesizeSigning(): Promise<NonNullable<StartLangGraphAdapterRunnerOptions["signing"]>> {
  const keys = (await generateEd25519KeyPair()) as webcrypto.CryptoKeyPair;
  const cert = await generateSelfSignedEd25519Cert({
    keys,
    subject: "CN=soa-langgraph-adapter-demo,O=SOA-Harness Adapter Self-Signed",
  });
   
  console.warn(DEMO_WARNING);
  return {
    alg: "EdDSA",
    kid: "soa-langgraph-adapter-demo",
    privateKey: keys.privateKey,
    x5c: [cert],
  };
}

/**
 * Compose the adapter's §5-compliant HTTP surface and start listening.
 *
 * This function is intentionally simple: no permission/audit/session
 * wiring here. The adapter's permission and audit flows live in
 * modules A (permission-hook.ts) and B (audit-sink.ts) and talk to a
 * separate back-end Runner. Phase 2.5's job is the Card surface.
 */
export async function startLangGraphAdapterRunner(
  opts: StartLangGraphAdapterRunnerOptions,
): Promise<LangGraphAdapterServer> {
  const agentCard = buildAdapterCard({
    baseCard: opts.baseCard,
    adapterVersion: opts.adapterVersion,
    ...(opts.adapterNotesOverrides ?? {}),
  });

  const signing = opts.signing ?? (await synthesizeSigning());

  // Event surface wiring (optional — Phase 2.6 addition).
  let emitter: StreamEventEmitter | undefined;
  let sessionStore: InMemorySessionStore | undefined;
  let eventsConfig: Parameters<typeof buildRunnerApp>[0]["eventsRecent"] | undefined;
  if (opts.events) {
    emitter = new StreamEventEmitter({ clock: () => new Date() });
    sessionStore = new InMemorySessionStore();
    sessionStore.register(opts.events.sessionId, opts.events.sessionBearer, {
      activeMode: opts.events.activeMode ?? "ReadOnly",
      canDecide: true,
    });
    eventsConfig = {
      emitter,
      sessionStore,
      clock: () => new Date(),
    };
  }

  const app = await buildRunnerApp({
    trust: opts.trust,
    card: agentCard,
    alg: signing.alg,
    kid: signing.kid,
    privateKey: signing.privateKey as Parameters<typeof buildRunnerApp>[0]["privateKey"],
    x5c: signing.x5c,
    // skipCardSchemaValidation: test fixtures OMIT real trustAnchor SPKIs
    // and baseCard bodies commonly carry placeholders; production callers
    // pass a validated card and this flag stays false.
    skipCardSchemaValidation: true,
    ...(eventsConfig ? { eventsRecent: eventsConfig } : {}),
  });

  // Phase 2.8 — /debug/backend-info. Demo-mode-only route registered
  // AFTER buildRunnerApp so it doesn't collide with any normative route.
  if (opts.debug) {
    const debugOpts = opts.debug;
    type FastifyWithRoutes = {
      get(
        path: string,
        handler: (
          request: { socket?: { remoteAddress?: string }; ip?: string },
          reply: { code(n: number): { send(body: unknown): unknown } },
        ) => Promise<unknown>,
      ): unknown;
    };
    (app as unknown as FastifyWithRoutes).get("/debug/backend-info", async (request, reply) => {
      const remote = request.socket?.remoteAddress ?? request.ip ?? "";
      // IPv4 loopback (127.0.0.0/8), IPv6 loopback (::1), + IPv4-mapped IPv6 (::ffff:127.x.x.x).
      const isLoopback =
        remote.startsWith("127.") ||
        remote === "::1" ||
        remote.startsWith("::ffff:127.");
      if (!isLoopback) {
        return reply.code(403).send({ error: "loopback-only", detail: `remote=${remote}` });
      }
      return reply.code(200).send({
        backend_url: debugOpts.backendUrl,
        admin_read_bearer: debugOpts.adminReadBearer ?? null,
      });
    });
  }

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7700;
  await app.listen({ host, port });

  const resolvedAddress = app.server.address();
  const resolvedPort =
    resolvedAddress && typeof resolvedAddress === "object" ? resolvedAddress.port : port;

  const events = opts.events && emitter
    ? {
        emitter,
        bridge: new EventBridge({ emitter, sessionId: opts.events.sessionId }),
        sessionId: opts.events.sessionId,
        sessionBearer: opts.events.sessionBearer,
      }
    : undefined;

  return {
    app,
    address: { host, port: resolvedPort },
    agentCard,
    ...(events ? { events } : {}),
    async close() {
      await app.close();
    },
  };
}
