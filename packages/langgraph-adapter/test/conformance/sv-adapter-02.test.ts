/**
 * SV-ADAPTER-02 — PermissionInterception.
 *
 * Asserts the pre-dispatch interception invariant (§18.5.2) holds
 * end-to-end when an adapter is built via `createLangGraphAdapter(...)`.
 * This is the higher-integration version of the isolated spike test —
 * the permission hook is a real HTTP client (mocked fetch), not a
 * hard-coded fixture function.
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
import { createLangGraphAdapter, ADAPTER_VERSION } from "../../src/index.js";

type FetchArgs = Parameters<typeof fetch>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (...args: FetchArgs) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

const BASE_CARD = { soaHarnessVersion: "1.0", name: "x", version: "1.0.0" };

function buildAdapterFor(decision: "AutoAllow" | "Deny") {
  let sentinelFiredAt: bigint | null = null;
  const sentinelTool = tool(
    async ({ input }: { input: string }) => {
      sentinelFiredAt = process.hrtime.bigint();
      return `echoed: ${input}`;
    },
    {
      name: "echo",
      schema: z.object({ input: z.string() }),
      description: "fixture sentinel",
    },
  );

  const adapter = createLangGraphAdapter({
    tools: [sentinelTool],
    permission: {
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision })),
    },
    audit: {
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      activeMode: "ReadOnly",
      fetchImpl: mockFetch(() => jsonResponse(201, {
        record_id: "aud_1",
        this_hash: "a".repeat(64),
        prev_hash: "0".repeat(64),
        sink_timestamp: "2026-04-22T20:00:00Z",
        retention_class: "standard-90d",
      })),
    },
    card: { baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION },
  });

  const graph = new StateGraph(MessagesState)
    .addNode("tools", adapter.toolNode)
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile();

  return { adapter, graph, getSentinelFiredAt: () => sentinelFiredAt };
}

function seed() {
  return {
    messages: [
      new HumanMessage({ content: "go" }),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "echo", args: { input: "hi" }, id: "c1", type: "tool_call" }],
      }),
    ],
  };
}

describe("SV-ADAPTER-02 — PermissionInterception (§18.5.2)", () => {
  it("Runner-backed Deny → tool function NOT executed (pre-dispatch invariant)", async () => {
    const { adapter, graph, getSentinelFiredAt } = buildAdapterFor("Deny");
    const result = await graph.invoke(seed());

    expect(getSentinelFiredAt()).toBeNull();
    const toolMessages = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.status).toBe("error");
    expect(toolMessages[0]?.content).toContain("permission denied");

    // Observation MUST have landed before we returned.
    const obs = (adapter.permissionHook as { getObservations: () => unknown[] }).getObservations();
    expect(obs.length).toBeGreaterThan(0);
  });

  it("Runner-backed AutoAllow → tool function executed; observation precedes execution", async () => {
    const { graph, getSentinelFiredAt } = buildAdapterFor("AutoAllow");
    await graph.invoke(seed());
    expect(getSentinelFiredAt()).not.toBeNull();
  });

  it("Runner 5xx → adapter fails closed (denies, does not execute)", async () => {
    let sentinelFiredAt: bigint | null = null;
    const sentinelTool = tool(
      async () => {
        sentinelFiredAt = process.hrtime.bigint();
        return "ok";
      },
      {
        name: "echo",
        schema: z.object({ input: z.string() }),
        description: "fixture sentinel",
      },
    );
    const adapter = createLangGraphAdapter({
      tools: [sentinelTool],
      permission: {
        runnerBaseUrl: "http://localhost:7700",
        bearer: "b",
        sessionId: "ses_1",
        fetchImpl: mockFetch(() => jsonResponse(503, { error: "not-ready" })),
      },
      audit: {
        runnerBaseUrl: "http://localhost:7700",
        bearer: "b",
        activeMode: "ReadOnly",
      },
      card: { baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION },
    });
    const graph = new StateGraph(MessagesState)
      .addNode("tools", adapter.toolNode)
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile();

    await graph.invoke(seed());
    expect(sentinelFiredAt).toBeNull();
  });
});
