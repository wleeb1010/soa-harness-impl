/**
 * Phase 0b spike tests — acceptance criteria for §18.5.2 pre-dispatch
 * interception.
 *
 * Three tests, one per criterion:
 *   (i)   Hook observes tool name + args BEFORE the underlying tool function
 *         (proved by temporal ordering: observation.at < sentinelFiredAt).
 *   (ii)  StateGraph invariants preserved — compile + state transitions
 *         complete (proved by full graph.invoke returning a valid state).
 *   (iii) Hardcoded deny CAUSES the tool function NOT to execute (proved by
 *         sentinelFiredAt remaining null after graph.invoke).
 *
 * A 4th allow-path test is included to round out the proof — without it,
 * (i) could trivially pass by never firing the sentinel at all.
 */

import { describe, it, expect } from "vitest";
import { ToolMessage, AIMessage } from "@langchain/core/messages";
import {
  buildSpikeGraph,
  makePermissionHook,
  makeSentinelTool,
  makeSpikeState,
  seedState,
} from "../src/spike.js";

describe("§18.5.2 pre-dispatch interception spike", () => {
  it("(iii) deny decision prevents the underlying tool function from executing", async () => {
    const state = makeSpikeState();
    const hook = makePermissionHook(state, "deny");
    const sentinelTool = makeSentinelTool(state);
    const graph = buildSpikeGraph(hook, sentinelTool);

    const result = await graph.invoke(seedState("echo", { input: "hi" }));

    expect(state.sentinelFiredAt).toBeNull();
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]?.name).toBe("echo");
    expect(state.observations[0]?.args).toEqual({ input: "hi" });

    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("permission denied");
    expect(toolMessages[0]?.status).toBe("error");
  });

  it("(i) observation timestamp strictly precedes tool execution on the allow path", async () => {
    const state = makeSpikeState();
    const hook = makePermissionHook(state, "allow");
    const sentinelTool = makeSentinelTool(state);
    const graph = buildSpikeGraph(hook, sentinelTool);

    await graph.invoke(seedState("echo", { input: "hi" }));

    expect(state.sentinelFiredAt).not.toBeNull();
    expect(state.observations).toHaveLength(1);
    // Temporal proof — observation landed BEFORE the tool function fired.
    expect(state.observations[0]!.at < state.sentinelFiredAt!).toBe(true);
  });

  it("(ii) graph compiles and completes a full state transition on both decision paths", async () => {
    for (const decision of ["allow", "deny"] as const) {
      const state = makeSpikeState();
      const hook = makePermissionHook(state, decision);
      const sentinelTool = makeSentinelTool(state);
      const graph = buildSpikeGraph(hook, sentinelTool);

      const result = await graph.invoke(seedState("echo", { input: "state-transition" }));

      // Final state contains: original Human + original AI + one ToolMessage
      // (approved tool result OR permission denial message).
      expect(result.messages).toHaveLength(3);
      expect(result.messages.at(-1)).toBeInstanceOf(ToolMessage);
    }
  });

  it("(iii-bis) allow decision does execute the tool — confirms sentinel is wired correctly", async () => {
    // Belt-and-braces: without this test, a broken sentinel (always null)
    // would make the deny test trivially pass.
    const state = makeSpikeState();
    const hook = makePermissionHook(state, "allow");
    const sentinelTool = makeSentinelTool(state);
    const graph = buildSpikeGraph(hook, sentinelTool);

    const result = await graph.invoke(seedState("echo", { input: "sanity" }));

    expect(state.sentinelFiredAt).not.toBeNull();
    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toBe("echoed: sanity");
  });

  it("mixed-batch: multi-tool AIMessage applies per-call decisions independently", async () => {
    // Smoke-test: two tool_calls in one AIMessage, one allowed / one denied.
    // Proves the gate handles heterogeneous batches without leakage to the
    // underlying ToolNode.
    const state = makeSpikeState();
    const sentinelTool = makeSentinelTool(state);
    let callCount = 0;
    const hook = {
      observe: (name: string, args: unknown) => {
        state.observations.push({ name, args, at: process.hrtime.bigint() });
      },
      decide: async (): Promise<"allow" | "deny"> => {
        callCount += 1;
        return callCount === 1 ? "deny" : "allow";
      },
    };
    const graph = buildSpikeGraph(hook, sentinelTool);

    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "echo", args: { input: "first-denied" }, id: "c1", type: "tool_call" },
        { name: "echo", args: { input: "second-allowed" }, id: "c2", type: "tool_call" },
      ],
    });
    const result = await graph.invoke({ messages: [ai] });

    expect(state.observations).toHaveLength(2);
    expect(state.sentinelFiredAt).not.toBeNull(); // allowed call did fire

    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(2);
    // First is the denial, second is the allowed result.
    expect(toolMessages[0]?.content).toContain("permission denied");
    expect(toolMessages[1]?.content).toBe("echoed: second-allowed");
  });
});
