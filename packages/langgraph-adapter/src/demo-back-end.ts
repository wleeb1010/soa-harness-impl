/**
 * Minimal back-end Runner for the adapter demo binary.
 *
 * Production-quality (not a test-only fixture) but deliberately scoped:
 *   - POST /permissions/decisions     — auto-allow for all tools by default;
 *                                        callers can inject a decide() fn for
 *                                        smoke scenarios.
 *   - POST /audit/tool-invocations    — delegates to a real @soa-harness/runner
 *                                        AuditChain for hash-chain integrity.
 *   - GET  /audit/records             — returns chain contents.
 *   - GET  /health                    — for readiness polling.
 *
 * Shared structure with test/e2e/back-end-runner-fixture.ts (Phase 2.6 cfddece),
 * promoted here to an importable module so the demo binary can stand up an
 * identical back-end without duplicating code.
 *
 * Not a full native Runner — the demo is about proving adapter conformance,
 * not re-running the Runner's own permission logic end-to-end. Real
 * deployments point the adapter at an operator-supplied Core Runner.
 */

import { fastify } from "fastify";
import { AuditChain, type AuditRecord } from "@soa-harness/runner";

export interface DemoBackEndOptions {
  /** Per-request decision picker. Default: always AutoAllow. */
  decide?: (req: { tool_name: string; args: unknown; session_id: string }) => {
    decision: "AutoAllow" | "Prompt" | "Deny" | "CapabilityDenied" | "ConfigPrecedenceViolation";
  };
  /** Bearer token the back-end accepts. Default: "adapter-demo-back-end". */
  expectedBearer?: string;
  /** Bind host. Default: "127.0.0.1". */
  host?: string;
  /** Bind port. Default: 0 (OS-assigned). */
  port?: number;
}

export interface DemoBackEnd {
  url: string;
  host: string;
  port: number;
  bearer: string;
  appendCount(): number;
  head(): AuditRecord | undefined;
  close(): Promise<void>;
}

export async function startDemoBackEnd(opts: DemoBackEndOptions = {}): Promise<DemoBackEnd> {
  const host = opts.host ?? "127.0.0.1";
  const bearer = opts.expectedBearer ?? "adapter-demo-back-end";
  const clock = () => new Date();
  const chain = new AuditChain(clock);
  const appended: AuditRecord[] = [];

  const app = fastify();

  app.addHook("onRequest", async (req, reply) => {
    // /health is the only unauthenticated surface.
    if (req.url === "/health") return;
    const hdr = req.headers["authorization"];
    if (typeof hdr !== "string" || !hdr.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing-bearer" });
    }
    const presented = hdr.slice("Bearer ".length).trim();
    if (presented !== bearer) {
      return reply.code(401).send({ error: "invalid-bearer" });
    }
  });

  app.get("/health", async () => ({ status: "alive", role: "adapter-demo-back-end" }));

  app.post("/permissions/decisions", async (req, reply) => {
    const body = req.body as { tool_name: string; args: unknown; session_id: string };
    const d = opts.decide ? opts.decide(body) : { decision: "AutoAllow" as const };
    reply.code(201);
    return {
      decision: d.decision,
      resolved_capability: "ReadOnly",
      resolved_control: "AutoAllow",
      reason: "demo-back-end",
      audit_record_id: `aud_decision_${appended.length}`,
      audit_this_hash: "0".repeat(64),
      handler_accepted: null,
      runner_version: "1.0",
      recorded_at: clock().toISOString(),
    };
  });

  app.post("/audit/tool-invocations", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const record_id = `aud_${appended.length.toString().padStart(8, "0")}`;
    const record = chain.append({
      record_id,
      session_id: String(body["session_id"] ?? ""),
      decision: "AutoAllow",
      capability: "ReadOnly",
      handler: "Interactive",
      tool_name: String(body["tool_name"] ?? ""),
      ...(typeof body["args_digest"] === "string" ? { args_digest: body["args_digest"] } : {}),
      ...(typeof body["retention_class"] === "string"
        ? { retention_class: body["retention_class"] }
        : {}),
    });
    appended.push(record);
    reply.code(201);
    return {
      record_id,
      this_hash: record.this_hash,
      prev_hash: record.prev_hash,
      sink_timestamp: (record["sink_timestamp"] as string) ?? clock().toISOString(),
      retention_class: (record["retention_class"] as string) ?? "standard-90d",
    };
  });

  app.get("/audit/records", async () => ({
    records: appended,
    next_after: null,
    has_more: false,
    runner_version: "1.0",
    generated_at: clock().toISOString(),
  }));

  await app.listen({ host, port: opts.port ?? 0 });
  const addr = app.server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : opts.port ?? 0;

  return {
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    bearer,
    appendCount: () => appended.length,
    head: () => appended.at(-1),
    async close() {
      await app.close();
    },
  };
}
