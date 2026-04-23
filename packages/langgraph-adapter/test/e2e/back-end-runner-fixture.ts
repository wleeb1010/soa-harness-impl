/**
 * Minimal back-end Runner fixture for Phase 2.6 e2e tests.
 *
 * Spins up a Fastify app exposing the two endpoints the adapter's
 * permission-hook + audit-sink call during normal operation:
 *
 *   POST /permissions/decisions     (adapter asks "may this tool run?")
 *   POST /audit/tool-invocations    (adapter forwards audit rows after dispatch)
 *   GET  /audit/records             (tests inspect the chain)
 *
 * Uses the REAL `AuditChain` from @soa-harness/runner so chain-integrity
 * assertions (prev_hash linking, JCS canonicalization) exercise production
 * code paths. The decision endpoint is a configurable stub — tests pick
 * allow / deny / prompt per case.
 *
 * Not a production fixture — deliberately small and test-focused.
 */

import { fastify } from "fastify";
import type { FastifyInstance } from "fastify";
import { AuditChain, type AuditRecord } from "@soa-harness/runner";

/** What /permissions/decisions returns — minimal shape the adapter parses. */
export interface StubDecision {
  decision: "AutoAllow" | "Prompt" | "Deny" | "CapabilityDenied" | "ConfigPrecedenceViolation";
}

export interface BackEndFixtureOptions {
  /** Per-request decision picker. Default: always AutoAllow. */
  decide?: (req: { tool_name: string; args: unknown; session_id: string }) => StubDecision;
  /** Expected bearer for authenticated endpoints. Default: "be-test-bearer". */
  expectedBearer?: string;
  /** Clock for AuditChain record_id + sink_timestamp. */
  clock?: () => Date;
}

export interface BackEndFixture {
  app: FastifyInstance;
  url: string;
  port: number;
  bearer: string;
  chain: AuditChain;
  /** Count of audit rows appended (diagnostic). */
  appendCount(): number;
  /** Snapshot of the chain's head record (undefined if empty). */
  head(): AuditRecord | undefined;
  close(): Promise<void>;
}

export async function startBackEndFixture(
  opts: BackEndFixtureOptions = {},
): Promise<BackEndFixture> {
  const bearer = opts.expectedBearer ?? "be-test-bearer";
  const clock = opts.clock ?? (() => new Date());
  const chain = new AuditChain(clock);
  const appended: AuditRecord[] = [];

  const app = fastify();

  app.addHook("onRequest", async (req, reply) => {
    // Auth gate — every endpoint requires the test bearer.
    const hdr = req.headers["authorization"];
    if (typeof hdr !== "string" || !hdr.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing-bearer" });
    }
    const presented = hdr.slice("Bearer ".length).trim();
    if (presented !== bearer) {
      return reply.code(401).send({ error: "invalid-bearer" });
    }
  });

  app.post("/permissions/decisions", async (req, reply) => {
    const body = req.body as { tool_name: string; args: unknown; session_id: string };
    const decision = opts.decide
      ? opts.decide(body)
      : ({ decision: "AutoAllow" } satisfies StubDecision);
    reply.code(201);
    return {
      decision: decision.decision,
      resolved_capability: "ReadOnly",
      resolved_control: "AutoAllow",
      reason: "stub",
      audit_record_id: `aud_decision_${appended.length}`,
      audit_this_hash: "0".repeat(64),
      handler_accepted: null,
      runner_version: "1.0",
      recorded_at: clock().toISOString(),
    };
  });

  app.post("/audit/tool-invocations", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    // Delegate to the real AuditChain for hash-chain integrity. This is
    // what SV-ADAPTER-04 probe (v) asserts. The record_id is fixture-
    // generated because AuditChain does not mint one itself.
    const record_id = `aud_${appended.length.toString().padStart(8, "0")}`;
    const record = chain.append({
      record_id,
      session_id: String(body.session_id ?? ""),
      decision: "AutoAllow",
      capability: "ReadOnly",
      handler: "Interactive",
      tool_name: String(body.tool_name ?? ""),
      ...(typeof body.args_digest === "string" ? { args_digest: body.args_digest } : {}),
      ...(typeof body.retention_class === "string" ? { retention_class: body.retention_class } : {}),
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

  app.get("/audit/records", async () => {
    return {
      records: appended,
      next_after: null,
      has_more: false,
      runner_version: "1.0",
      generated_at: clock().toISOString(),
    };
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    app,
    url,
    port,
    bearer,
    chain,
    appendCount: () => appended.length,
    head: () => appended.at(-1),
    async close() {
      await app.close();
    },
  };
}
