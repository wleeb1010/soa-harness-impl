/**
 * SV-ADAPTER-03 end-to-end over real HTTP — closes Phase 2.5 criterion (iii).
 *
 * Drives the pinned LangGraph fixture trace through the adapter's
 * `EventBridge`, then reads /events/recent off the adapter's live
 * HTTP surface. Asserts the direct-mapped SOA event sequence lands in
 * the ring buffer and serves out of the endpoint in the expected order.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startLangGraphAdapterRunner,
  ADAPTER_VERSION,
  type LangGraphAdapterServer,
  type LangGraphEvent,
  type SoaStreamEventType,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "..", "fixtures", "simple-agent-trace.json");

interface Fixture {
  langgraph_events: LangGraphEvent[];
  expected_soa_emission: Array<{ type: SoaStreamEventType }>;
}
const FIXTURE: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const ORCHESTRATOR_SYNTHETIC: ReadonlySet<SoaStreamEventType> = new Set([
  "MemoryLoad",
  "PermissionPrompt",
  "PermissionDecision",
  "PreToolUseOutcome",
  "PostToolUseOutcome",
  "ToolInputEnd",
]);

const BASE_CARD: Record<string, unknown> = { soaHarnessVersion: "1.0", name: "e2e-03", version: "1.0.0" };
const TRUST = {
  soaHarnessVersion: "1.0" as const,
  publisher_kid: "soa-release-v1.0",
  spki_sha256: "0".repeat(64),
  issuer: "CN=Test CA",
  issued_at: "2026-01-01T00:00:00Z",
  channel: "sdk-pinned" as const,
};

describe("SV-ADAPTER-03 e2e — event-mapping via real /events/recent", () => {
  let server: LangGraphAdapterServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("fixture trace drives /events/recent byte-identity-minus-nondeterminism", async () => {
    server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: TRUST,
      port: 0,
      events: {
        sessionId: "ses_e2e03abcdef123456",
        sessionBearer: "events-test-bearer",
      },
    });
    expect(server.events).toBeDefined();
    const { bridge, sessionId, sessionBearer } = server.events!;

    // Push every LangGraph event through the bridge; synthetic events
    // skipped (orchestrator-sourced).
    for (const ev of FIXTURE.langgraph_events) {
      bridge.dispatch(ev);
    }

    const resp = await fetch(
      `http://127.0.0.1:${server.address.port}/events/recent?session_id=${sessionId}`,
      { headers: { authorization: `Bearer ${sessionBearer}` } },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { events: Array<{ type: SoaStreamEventType; sequence: number }> };

    const producedTypes = body.events.map((e) => e.type);
    const expectedDirect = FIXTURE.expected_soa_emission
      .map((e) => e.type)
      .filter((t) => !ORCHESTRATOR_SYNTHETIC.has(t));

    expect(producedTypes).toEqual(expectedDirect);

    // Sequence numbers MUST be monotonic + gapless.
    const sequences = body.events.map((e) => e.sequence);
    for (let i = 0; i < sequences.length; i++) expect(sequences[i]).toBe(i);
  });

  it("emitSynthetic weaves orchestrator-sourced events into the stream", async () => {
    server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: TRUST,
      port: 0,
      events: {
        sessionId: "ses_e2e03abcdef123456b",
        sessionBearer: "events-test-bearer",
      },
    });
    const { bridge, sessionId, sessionBearer } = server.events!;

    // Mix direct-mapped + synthetic events.
    bridge.dispatch({ event: "on_thread_start", run_id: "t1" });
    bridge.emitSynthetic("MemoryLoad", { loaded_count: 3, tokens: 42 });
    bridge.dispatch({ event: "on_chat_model_start", run_id: "llm1" });
    bridge.emitSynthetic("PermissionDecision", { prompt_id: "prm_x", decision: "allow", scope: "once" });

    const resp = await fetch(
      `http://127.0.0.1:${server.address.port}/events/recent?session_id=${sessionId}`,
      { headers: { authorization: `Bearer ${sessionBearer}` } },
    );
    const body = (await resp.json()) as { events: Array<{ type: SoaStreamEventType }> };
    expect(body.events.map((e) => e.type)).toEqual([
      "SessionStart",
      "MemoryLoad",
      "MessageStart",
      "PermissionDecision",
    ]);
  });
});
