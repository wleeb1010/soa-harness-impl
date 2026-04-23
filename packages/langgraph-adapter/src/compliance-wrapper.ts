/**
 * Compliance wrapper — the core Phase 1 primitive.
 *
 * Wraps a LangGraph.js `ToolNode` as a permission-aware graph node so
 * the resulting StateGraph satisfies §18.5.2 pre-dispatch interception
 * per SOA-Harness Core. Implementation is the "substitute-permission-
 * aware tool executor" pattern validated by the Phase 0b spike
 * (see scratch/phase-0b/): every tool_call is routed through a
 * `PermissionHook` before the underlying ToolNode ever sees it.
 *
 * Permission-hook wiring (HTTP → /permissions/decisions), PermissionPrompt
 * StreamEvent synthesis, and the full §14.6 event map are Phase 2
 * concerns and are intentionally NOT plumbed here yet. This module is
 * the smallest shippable unit that demonstrates the invariant holds
 * inside the adapter package (not just in a throwaway spike).
 */

import type { AIMessageFields } from "@langchain/core/messages";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { PermissionHook, PermissionDecision } from "./types.js";

/** Shape the node receives — matches LangGraph's messages-state idiom. */
export interface MessagesState {
  messages: BaseMessage[];
}

/**
 * The tools array shape accepted by LangGraph's ToolNode. Union of
 * StructuredToolInterface / DynamicTool / RunnableToolLike. Extracted
 * from ConstructorParameters so we stay in sync with LangGraph's
 * upstream type without hand-maintaining the union.
 */
export type ToolNodeTool = ConstructorParameters<typeof ToolNode>[0][number];

/**
 * Produce a LangGraph node that intercepts tool dispatch before the
 * underlying ToolNode is invoked. Denied calls synthesize a
 * `ToolMessage` with `status: "error"` and never reach the
 * dispatcher; approved calls are forwarded to the inner ToolNode with
 * a filtered `AIMessage` containing only approved tool_calls.
 *
 * Ordering (§18.5.2 item 2):
 *   observe → decide → partition → (for approved) forward to ToolNode
 *                                  (for denied)  synthesize ToolMessage{error}
 *
 * Returned node is suitable for `.addNode("tools", ...)` inside any
 * user-supplied StateGraph.
 */
export function buildPermissionAwareToolNode(args: {
  tools: ToolNodeTool[];
  hook: PermissionHook;
}): (state: MessagesState, config?: RunnableConfig) => Promise<Partial<MessagesState>> {
  const { tools, hook } = args;
  const innerToolNode = new ToolNode(tools);

  return async function permissionAwareTools(state, config) {
    const last = state.messages.at(-1);
    if (!(last instanceof AIMessage) || !last.tool_calls?.length) {
      return {};
    }

    const denials: ToolMessage[] = [];
    const approvedCalls: NonNullable<AIMessage["tool_calls"]> = [];
    const decisions: Array<{ name: string; args: unknown; decision: PermissionDecision }> = [];

    for (const tc of last.tool_calls) {
      hook.observe(tc.name, tc.args);
      const decision = await hook.decide(tc.name, tc.args);
      decisions.push({ name: tc.name, args: tc.args, decision });
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

    if (approvedCalls.length === 0) {
      return { messages: denials };
    }

    const filteredFields: AIMessageFields = {
      content: last.content,
      tool_calls: approvedCalls,
    };
    if (last.id !== undefined) filteredFields.id = last.id;
    const filteredLast = new AIMessage(filteredFields);
    const delegated = (await innerToolNode.invoke(
      { messages: [filteredLast] },
      config,
    )) as MessagesState;

    return { messages: [...denials, ...delegated.messages] };
  };
}
