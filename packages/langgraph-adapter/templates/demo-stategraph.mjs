// demo-stategraph.mjs — reference LangGraph StateGraph wired through
// @soa-harness/langgraph-adapter. Self-contained runnable example; copy
// into your own project as a starting point.
//
// Exports `buildGraph({ toolNode })` — `toolNode` is the permission-aware
// graph node produced by `createLangGraphAdapter(...).toolNode` per
// §18.5.2 pre-dispatch interception.
//
// The graph topology is deliberately minimal: START → tools → END. Real
// agents extend with an LLM node, conditional edges back to tools, and a
// memory-load node per §14.6.3's example trace. Everything past the
// permission-aware tools node is orthogonal to adapter conformance.

import {
  START,
  END,
  Annotation,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const MessagesState = Annotation.Root({
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export const echoTool = tool(
  async ({ input }) => {
    return `echoed: ${input}`;
  },
  {
    name: "echo",
    description: "Echo a string back — used as the one-tool fixture for SV-ADAPTER probes.",
    schema: z.object({ input: z.string() }),
  },
);

export function buildGraph({ toolNode }) {
  return new StateGraph(MessagesState)
    .addNode("tools", toolNode)
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile();
}
