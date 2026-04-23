/**
 * Phase 0b feasibility spike — LangGraph pre-dispatch permission interception.
 *
 * Proves that a LangGraph StateGraph can intercept tool dispatch BEFORE
 * execution per SOA-Harness Core §18.5.2 (M4 Phase 0a, commit 654dc7b / L-52).
 *
 * Strategy: "substitute a permission-aware tool executor" per §18.5.2 item 2.
 * We register a single graph node that (a) observes each tool_call, (b) asks a
 * permission hook, and (c) delegates ONLY approved calls to the underlying
 * ToolNode. Denied calls short-circuit to a ToolMessage without reaching
 * ToolNode at all — so the host framework's dispatcher never sees them.
 *
 * Throwaway — production wiring lives in packages/langgraph-adapter/ (Phase 1).
 */

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  START,
  END,
  Annotation,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

// --- Observability channels -----------------------------------------------
// `observations` captures the pre-dispatch hook calls; `sentinelFiredAt`
// flips ONLY when the underlying tool function actually executes. The tests
// assert temporal ordering: every observation.at < sentinelFiredAt, proving
// the interception happens BEFORE dispatch (§18.5.2 item 1).

export type Observation = { readonly name: string; readonly args: unknown; readonly at: bigint };

export type SpikeState = {
  observations: Observation[];
  sentinelFiredAt: bigint | null;
};

export function makeSpikeState(): SpikeState {
  return { observations: [], sentinelFiredAt: null };
}

// --- Sentinel tool ---------------------------------------------------------
// `echo` returns its input but also records a high-resolution timestamp when
// it fires. If the permission hook denies, this timestamp MUST remain null.

export function makeSentinelTool(state: SpikeState) {
  return tool(
    async ({ input }: { input: string }) => {
      state.sentinelFiredAt = process.hrtime.bigint();
      return `echoed: ${input}`;
    },
    {
      name: "echo",
      description: "echo the input — spike sentinel tool",
      schema: z.object({ input: z.string() }),
    },
  );
}

// --- Permission hook -------------------------------------------------------

export type Decision = "allow" | "deny";

export interface PermissionHook {
  observe(name: string, args: unknown): void;
  decide(name: string, args: unknown): Promise<Decision>;
}

export function makePermissionHook(state: SpikeState, fixed: Decision): PermissionHook {
  return {
    observe(name, args) {
      state.observations.push({ name, args, at: process.hrtime.bigint() });
    },
    async decide() {
      return fixed;
    },
  };
}

// --- Graph state annotation -----------------------------------------------

const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

// --- The substitute tool executor -----------------------------------------
// Registered as the graph's "tools" node. Matches §18.5.2 item 2 —
// "substituting a permission-aware tool executor at host-framework
// registration time." The underlying ToolNode is invoked ONLY for approved
// calls; denied calls never reach it.

export function buildSpikeGraph(
  hook: PermissionHook,
  sentinelTool: ReturnType<typeof makeSentinelTool>,
) {
  const innerToolNode = new ToolNode([sentinelTool]);

  async function permissionAwareTools(state: typeof MessagesState.State) {
    const last = state.messages.at(-1);
    if (!(last instanceof AIMessage) || !last.tool_calls?.length) {
      return {};
    }

    const denials: ToolMessage[] = [];
    const approvedCalls: NonNullable<AIMessage["tool_calls"]> = [];

    for (const tc of last.tool_calls) {
      // (i) Observation — fires BEFORE any dispatch path. The sentinel tool's
      // timestamp is still null here because innerToolNode hasn't been invoked.
      hook.observe(tc.name, tc.args);
      const decision = await hook.decide(tc.name, tc.args);
      if (decision === "allow") {
        approvedCalls.push(tc);
      } else {
        denials.push(
          new ToolMessage({
            content: `permission denied for tool ${tc.name}`,
            tool_call_id: tc.id ?? "unknown",
            name: tc.name,
            status: "error",
          }),
        );
      }
    }

    // (iii) No-approved fast-path: if everything was denied, we never invoke
    // the underlying ToolNode. The sentinel tool function cannot fire.
    if (approvedCalls.length === 0) {
      return { messages: denials };
    }

    // Synthesize a minimal state with ONLY the approved tool_calls for
    // delegation. This keeps the underlying ToolNode oblivious to denials.
    const filteredLast = new AIMessage({
      content: last.content,
      tool_calls: approvedCalls,
      id: last.id,
    });
    const delegated = await innerToolNode.invoke({
      messages: [filteredLast],
    });

    return { messages: [...denials, ...delegated.messages] };
  }

  return new StateGraph(MessagesState)
    .addNode("tools", permissionAwareTools)
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile();
}

// --- Convenience: build a seed state with one tool_call -------------------

export function seedState(toolName: string, args: unknown, callId = "call_1") {
  return {
    messages: [
      new HumanMessage({ content: "trigger tool" }),
      new AIMessage({
        content: "",
        tool_calls: [{ name: toolName, args: args as Record<string, unknown>, id: callId, type: "tool_call" }],
      }),
    ],
  };
}
