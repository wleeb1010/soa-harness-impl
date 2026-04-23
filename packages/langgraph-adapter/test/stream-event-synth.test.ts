/**
 * Stream-event synthesizer tests — §14.6 direct-mapping unit tests plus
 * SV-ADAPTER-03 fixture replay.
 *
 * The fixture (`test/fixtures/simple-agent-trace.json`, copied from
 * test-vectors/langgraph-adapter/ at the pinned spec commit) carries
 * both the input LangGraph astream_events v2 trace and the expected
 * SOA StreamEvent emission. We assert that the EventMapper's direct
 * emissions (post-filtering the §14.6.2 synthetic events woven in by
 * the orchestrator at runtime) match the fixture's expected sequence
 * exactly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventMapper, type LangGraphEvent, type SoaStreamEventType } from "../src/stream-event-synth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "simple-agent-trace.json");

interface Fixture {
  langgraph_events: LangGraphEvent[];
  expected_soa_emission: Array<{ type: SoaStreamEventType }>;
}

const FIXTURE: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/**
 * Event types synthesized outside the direct-mapping layer (by the
 * orchestrator, permission-hook, memory layer, or §15 hook pipeline).
 * The EventMapper does NOT emit these, so they are filtered out of
 * the fixture's expected_soa_emission before sequence comparison.
 */
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

describe("stream-event-synth — §14.6 direct mapping", () => {
  it("replays the SV-ADAPTER-03 fixture's direct-mapped events in order", () => {
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
});

describe("stream-event-synth — individual mapping rules", () => {
  it("on_thread_start emits SessionStart exactly once", () => {
    const m = new EventMapper();
    const first = m.map({ event: "on_thread_start", run_id: "t1", name: "thread" });
    const second = m.map({ event: "on_thread_start", run_id: "t2", name: "thread" });
    expect(first).toEqual([{ type: "SessionStart", payload: {} }]);
    expect(second).toEqual([]);
  });

  it("non-root on_chain_start is dropped; root version emits SessionStart", () => {
    const m1 = new EventMapper();
    expect(m1.map({ event: "on_chain_start", run_id: "n1", metadata: {} })).toEqual([]);

    const m2 = new EventMapper();
    expect(m2.map({ event: "on_chain_start", run_id: "r1", metadata: { is_root: true } }))
      .toEqual([{ type: "SessionStart", payload: {} }]);
  });

  it("on_chain_error (root) emits SessionEnd with stop_reason Failed", () => {
    const m = new EventMapper();
    const out = m.map({ event: "on_chain_error", run_id: "r1", metadata: { is_root: true } });
    expect(out).toEqual([{ type: "SessionEnd", payload: { stop_reason: "Failed" } }]);
  });

  it("on_thread_end is idempotent; second call returns []", () => {
    const m = new EventMapper();
    expect(m.map({ event: "on_thread_end", run_id: "t1" })).toEqual([
      { type: "SessionEnd", payload: { stop_reason: "Completed" } },
    ]);
    expect(m.map({ event: "on_thread_end", run_id: "t1" })).toEqual([]);
  });

  it("first on_chat_model_stream emits ContentBlockStart + ContentBlockDelta", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm1" });
    const out = m.map({ event: "on_chat_model_stream", run_id: "llm1", data: { chunk: "hello" } });
    expect(out.map((e) => e.type)).toEqual(["ContentBlockStart", "ContentBlockDelta"]);
    expect(out[1]?.payload).toMatchObject({ delta: "hello" });
  });

  it("subsequent on_chat_model_stream for same run_id emits only ContentBlockDelta", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm1" });
    m.map({ event: "on_chat_model_stream", run_id: "llm1", data: { chunk: "first" } });
    const out = m.map({ event: "on_chat_model_stream", run_id: "llm1", data: { chunk: "second" } });
    expect(out.map((e) => e.type)).toEqual(["ContentBlockDelta"]);
  });

  it("on_chat_model_end closes the block then emits MessageEnd", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm1" });
    m.map({ event: "on_chat_model_stream", run_id: "llm1", data: { chunk: "hi" } });
    const out = m.map({ event: "on_chat_model_end", run_id: "llm1" });
    expect(out.map((e) => e.type)).toEqual(["ContentBlockEnd", "MessageEnd"]);
  });

  it("on_chat_model_end with no prior stream emits only MessageEnd (no block to close)", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm1" });
    const out = m.map({ event: "on_chat_model_end", run_id: "llm1" });
    expect(out.map((e) => e.type)).toEqual(["MessageEnd"]);
  });

  it("on_tool_start → ToolInputStart carries tool_call_id + tool_name", () => {
    const m = new EventMapper();
    const out = m.map({ event: "on_tool_start", run_id: "run_xyz", name: "get_weather" });
    expect(out).toEqual([
      { type: "ToolInputStart", payload: { tool_call_id: "run_xyz", tool_name: "get_weather" } },
    ]);
  });

  it("on_tool_end → ToolResult with ok=true", () => {
    const m = new EventMapper();
    const out = m.map({ event: "on_tool_end", run_id: "run_xyz", name: "get_weather" });
    expect(out).toEqual([
      { type: "ToolResult", payload: { tool_call_id: "run_xyz", ok: true } },
    ]);
  });

  it("on_tool_error → ToolError with truncated message", () => {
    const m = new EventMapper();
    const longMsg = "x".repeat(2000);
    const out = m.map({ event: "on_tool_error", run_id: "run_xyz", data: { error: longMsg } });
    expect(out[0]?.type).toBe("ToolError");
    const payload = out[0]?.payload as { message: string };
    expect(payload.message.length).toBe(1024);
  });

  it("on_interrupt → PermissionPrompt with prm_-prefixed prompt_id", () => {
    const m = new EventMapper();
    const out = m.map({ event: "on_interrupt", run_id: "int1" });
    expect(out).toEqual([{ type: "PermissionPrompt", payload: { prompt_id: "prm_int1" } }]);
  });

  it("on_text legacy callback maps to ContentBlockStart+Delta on first chunk", () => {
    const m = new EventMapper();
    const out = m.map({ event: "on_text", run_id: "txt1", data: { chunk: "legacy" } });
    expect(out.map((e) => e.type)).toEqual(["ContentBlockStart", "ContentBlockDelta"]);
  });

  it("dropped events (retriever/checkpoint/node/channel/agent_action/custom) return []", () => {
    const m = new EventMapper();
    for (const ev of [
      "on_retriever_start",
      "on_retriever_end",
      "on_checkpoint_start",
      "on_checkpoint_end",
      "on_node_start",
      "on_node_end",
      "on_channel_write",
      "on_channel_read",
      "on_agent_action",
      "on_agent_finish",
      "on_prompt_start",
      "on_prompt_end",
      "on_parser_start",
      "on_parser_end",
      "on_custom_event",
      "on_state_update",
      "on_graph_stream",
      "on_llm_error",
    ]) {
      expect(m.map({ event: ev, run_id: "x" })).toEqual([]);
    }
  });

  it("on_chat_model_stream with object-shaped chunk (content field) extracts the delta", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm1" });
    const out = m.map({
      event: "on_chat_model_stream",
      run_id: "llm1",
      data: { chunk: { content: "nested-delta" } },
    });
    const delta = out[1]?.payload as { delta: string };
    expect(delta.delta).toBe("nested-delta");
  });

  it("parallel tool/llm runs do not cross-pollute block state", () => {
    const m = new EventMapper();
    m.map({ event: "on_chat_model_start", run_id: "llm_a" });
    m.map({ event: "on_chat_model_start", run_id: "llm_b" });
    const a1 = m.map({ event: "on_chat_model_stream", run_id: "llm_a", data: { chunk: "a1" } });
    const b1 = m.map({ event: "on_chat_model_stream", run_id: "llm_b", data: { chunk: "b1" } });
    // Both sequences start fresh — each emits ContentBlockStart + Delta.
    expect(a1.map((e) => e.type)).toEqual(["ContentBlockStart", "ContentBlockDelta"]);
    expect(b1.map((e) => e.type)).toEqual(["ContentBlockStart", "ContentBlockDelta"]);
    // block_ids MUST differ.
    expect((a1[0]?.payload as { block_id: string }).block_id).not.toBe(
      (b1[0]?.payload as { block_id: string }).block_id,
    );
  });
});
