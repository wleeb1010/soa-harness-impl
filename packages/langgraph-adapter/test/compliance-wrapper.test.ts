/**
 * Compliance-wrapper regression tests — the Phase 1 adapter's
 * pre-dispatch interception invariant.
 *
 * Patterns promoted from scratch/phase-0b/ (the throwaway feasibility
 * spike) and graduated into this package's permanent test suite per
 * the M4 plan. The sentinel + temporal-ordering invariant (§18.5.2)
 * now lives here and runs on every build.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  START,
  END,
  Annotation,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { z } from "zod";
import { buildPermissionAwareToolNode } from "../src/compliance-wrapper.js";
import type { PermissionDecision, PermissionHook } from "../src/types.js";

type SpikeState = {
  observations: Array<{ name: string; args: unknown; at: bigint }>;
  sentinelFiredAt: bigint | null;
};

function makeState(): SpikeState {
  return { observations: [], sentinelFiredAt: null };
}

function makeSentinelTool(state: SpikeState) {
  return tool(
    async ({ input }: { input: string }) => {
      state.sentinelFiredAt = process.hrtime.bigint();
      return `echoed: ${input}`;
    },
    {
      name: "echo",
      description: "echo the input — sentinel for pre-dispatch interception tests",
      schema: z.object({ input: z.string() }),
    },
  );
}

function makeHook(state: SpikeState, fixed: PermissionDecision): PermissionHook {
  return {
    observe(name, args) {
      state.observations.push({ name, args, at: process.hrtime.bigint() });
    },
    async decide() {
      return fixed;
    },
  };
}

const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

function buildGraph(tools: ReturnType<typeof makeSentinelTool>[], hook: PermissionHook) {
  return new StateGraph(MessagesState)
    .addNode("tools", buildPermissionAwareToolNode({ tools, hook }))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile();
}

function seed(toolName: string, args: unknown, id = "call_1") {
  return {
    messages: [
      new HumanMessage({ content: "trigger tool" }),
      new AIMessage({
        content: "",
        tool_calls: [{ name: toolName, args: args as Record<string, unknown>, id, type: "tool_call" }],
      }),
    ],
  };
}

describe("§18.5.2 pre-dispatch interception — compliance-wrapper", () => {
  it("deny decision prevents the underlying tool function from executing", async () => {
    const state = makeState();
    const sentinel = makeSentinelTool(state);
    const hook = makeHook(state, "deny");
    const graph = buildGraph([sentinel], hook);

    const result = await graph.invoke(seed("echo", { input: "hi" }));

    expect(state.sentinelFiredAt).toBeNull();
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]?.name).toBe("echo");
    expect(state.observations[0]?.args).toEqual({ input: "hi" });

    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("permission denied");
    expect(toolMessages[0]?.status).toBe("error");
  });

  it("observation timestamp strictly precedes tool execution on the allow path", async () => {
    const state = makeState();
    const sentinel = makeSentinelTool(state);
    const hook = makeHook(state, "allow");
    const graph = buildGraph([sentinel], hook);

    await graph.invoke(seed("echo", { input: "hi" }));

    expect(state.sentinelFiredAt).not.toBeNull();
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]!.at < state.sentinelFiredAt!).toBe(true);
  });

  it("graph compiles and completes a full state transition on both decision paths", async () => {
    for (const decision of ["allow", "deny"] as const) {
      const state = makeState();
      const sentinel = makeSentinelTool(state);
      const hook = makeHook(state, decision);
      const graph = buildGraph([sentinel], hook);

      const result = await graph.invoke(seed("echo", { input: "state-transition" }));
      expect(result.messages).toHaveLength(3);
      expect(result.messages.at(-1)).toBeInstanceOf(ToolMessage);
    }
  });

  it("mixed-batch: multi-tool AIMessage applies per-call decisions independently", async () => {
    const state = makeState();
    const sentinel = makeSentinelTool(state);
    let n = 0;
    const hook: PermissionHook = {
      observe(name, args) {
        state.observations.push({ name, args, at: process.hrtime.bigint() });
      },
      async decide(): Promise<PermissionDecision> {
        n += 1;
        return n === 1 ? "deny" : "allow";
      },
    };
    const graph = buildGraph([sentinel], hook);

    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "echo", args: { input: "first-denied" }, id: "c1", type: "tool_call" },
        { name: "echo", args: { input: "second-allowed" }, id: "c2", type: "tool_call" },
      ],
    });
    const result = await graph.invoke({ messages: [ai] });

    expect(state.observations).toHaveLength(2);
    expect(state.sentinelFiredAt).not.toBeNull();

    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("permission denied");
    expect(toolMessages[1]?.content).toBe("echoed: second-allowed");
  });

  it("no-op on state without tool_calls", async () => {
    const state = makeState();
    const sentinel = makeSentinelTool(state);
    const hook = makeHook(state, "allow");
    const graph = buildGraph([sentinel], hook);

    // AIMessage with no tool_calls → wrapper returns {}; graph still terminates.
    const result = await graph.invoke({
      messages: [
        new HumanMessage({ content: "just chatting" }),
        new AIMessage({ content: "ok" }),
      ],
    });

    expect(state.observations).toHaveLength(0);
    expect(state.sentinelFiredAt).toBeNull();
    expect(result.messages).toHaveLength(2);
  });
});
