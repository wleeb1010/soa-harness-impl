/**
 * SV-ADAPTER-03 — EventMapping.
 *
 * Replays the pinned reference trace (test-vectors/langgraph-adapter/
 * simple-agent-trace.json, vendored in test/fixtures/) through the
 * adapter's EventMapper and asserts the produced SOA StreamEvent
 * sequence matches the fixture's expected emission modulo §14.6.2
 * synthetic events (which are orchestrator-sourced, not mapper-sourced).
 *
 * Extends stream-event-synth.test.ts with the conformance-probe framing
 * — same invariant, exposed here under the SV-ADAPTER-03 test ID so the
 * conformance test matrix is single-source-of-truth.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventMapper, type LangGraphEvent, type SoaStreamEventType } from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "..", "fixtures", "simple-agent-trace.json");

interface Fixture {
  langgraph_events: LangGraphEvent[];
  expected_soa_emission: Array<{ type: SoaStreamEventType; rationale?: string }>;
}

const FIXTURE: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const ORCHESTRATOR_SYNTHETIC: ReadonlySet<SoaStreamEventType> = new Set([
  "MemoryLoad",
  "PermissionPrompt",
  "PermissionDecision",
  "PreToolUseOutcome",
  "PostToolUseOutcome",
  "ToolInputEnd",
  "CompactionStart",
  "CompactionEnd",
  "CrashEvent",
  "HandoffStart",
  "HandoffComplete",
  "HandoffFailed",
  "SelfImprovementStart",
  "SelfImprovementAccepted",
  "SelfImprovementRejected",
  "SelfImprovementOrphaned",
]);

describe("SV-ADAPTER-03 — EventMapping (§14.6)", () => {
  it("reference trace → expected SOA sequence (direct-mapped subset)", () => {
    const mapper = new EventMapper();
    const produced: SoaStreamEventType[] = [];
    for (const ev of FIXTURE.langgraph_events) {
      for (const emitted of mapper.map(ev)) {
        produced.push(emitted.type);
      }
    }
    const expectedDirect = FIXTURE.expected_soa_emission
      .map((e) => e.type)
      .filter((t) => !ORCHESTRATOR_SYNTHETIC.has(t));
    expect(produced).toEqual(expectedDirect);
  });

  it("mapper is stateful per-run — new instance does not carry block state across sessions", () => {
    const m1 = new EventMapper();
    m1.map({ event: "on_chat_model_start", run_id: "r1" });
    m1.map({ event: "on_chat_model_stream", run_id: "r1", data: { chunk: "x" } });
    // Second mapper instance: fresh block state.
    const m2 = new EventMapper();
    const fresh = m2.map({ event: "on_chat_model_stream", run_id: "r1", data: { chunk: "y" } });
    // First stream on fresh mapper → ContentBlockStart + Delta (not just Delta).
    expect(fresh.map((e) => e.type)).toEqual(["ContentBlockStart", "ContentBlockDelta"]);
  });
});
