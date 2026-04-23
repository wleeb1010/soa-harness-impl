/**
 * SV-ADAPTER-02 end-to-end over real HTTP — closes Phase 2.5 criterion (iv).
 *
 * Spins up a real back-end Runner fixture on one port, an adapter
 * composition on another. Drives tool dispatch through the adapter's
 * permission-aware ToolNode. Permission decisions are made by the
 * back-end fixture over real HTTP — no mocked fetch.
 *
 * Asserts the pre-dispatch invariant holds: when the back-end replies
 * Deny, the underlying tool function's sentinel stays untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { startBackEndFixture, type BackEndFixture } from "./back-end-runner-fixture.js";
import {
  createLangGraphAdapter,
  ADAPTER_VERSION,
} from "../../src/index.js";

const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

const BASE_CARD: Record<string, unknown> = { soaHarnessVersion: "1.0", name: "e2e-adapter", version: "1.0.0" };

function seed(toolName = "echo", args: unknown = { input: "hi" }) {
  return {
    messages: [
      new HumanMessage({ content: "go" }),
      new AIMessage({
        content: "",
        tool_calls: [{ name: toolName, args: args as Record<string, unknown>, id: "c1", type: "tool_call" }],
      }),
    ],
  };
}

describe("SV-ADAPTER-02 e2e — permission-interception over real HTTP", () => {
  let backEnd: BackEndFixture;

  beforeEach(async () => {
    // Default AutoAllow — individual tests may override.
    backEnd = await startBackEndFixture();
  });

  afterEach(async () => {
    await backEnd.close();
  });

  async function runGraphWith(decision: "AutoAllow" | "Deny" | "Prompt") {
    await backEnd.close();
    backEnd = await startBackEndFixture({ decide: () => ({ decision }) });

    let sentinelFiredAt: bigint | null = null;
    const sentinelTool = tool(
      async ({ input }: { input: string }) => {
        sentinelFiredAt = process.hrtime.bigint();
        return `echoed: ${input}`;
      },
      { name: "echo", schema: z.object({ input: z.string() }), description: "fixture sentinel" },
    );

    const adapter = createLangGraphAdapter({
      tools: [sentinelTool],
      permission: {
        runnerBaseUrl: backEnd.url,
        bearer: backEnd.bearer,
        sessionId: "ses_e2e02abcdef123456",
      },
      audit: {
        runnerBaseUrl: backEnd.url,
        bearer: backEnd.bearer,
        activeMode: "ReadOnly",
      },
      card: { baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION },
    });

    const graph = new StateGraph(MessagesState)
      .addNode("tools", adapter.toolNode)
      .addEdge(START, "tools")
      .addEdge("tools", END)
      .compile();

    const result = await graph.invoke(seed());
    return { result, sentinelFiredAt };
  }

  it("Deny over real HTTP → sentinel stays null; denial ToolMessage lands", async () => {
    const { result, sentinelFiredAt } = await runGraphWith("Deny");
    expect(sentinelFiredAt).toBeNull();
    const tm = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(tm).toHaveLength(1);
    expect(tm[0]?.status).toBe("error");
    expect(tm[0]?.content).toContain("permission denied");
  });

  it("AutoAllow over real HTTP → sentinel fires; tool result in graph state", async () => {
    const { result, sentinelFiredAt } = await runGraphWith("AutoAllow");
    expect(sentinelFiredAt).not.toBeNull();
    const tm = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(tm).toHaveLength(1);
    expect(tm[0]?.content).toBe("echoed: hi");
  });

  it("Prompt (HITL-required, not wired) over real HTTP → treated as deny", async () => {
    const { sentinelFiredAt } = await runGraphWith("Prompt");
    expect(sentinelFiredAt).toBeNull();
  });

  it("Back-end 401 (invalid bearer) → adapter fails closed", async () => {
    let sentinelFiredAt: bigint | null = null;
    const sentinelTool = tool(
      async () => {
        sentinelFiredAt = process.hrtime.bigint();
        return "ok";
      },
      { name: "echo", schema: z.object({ input: z.string() }), description: "fixture sentinel" },
    );

    const adapter = createLangGraphAdapter({
      tools: [sentinelTool],
      permission: {
        runnerBaseUrl: backEnd.url,
        bearer: "wrong-bearer",
        sessionId: "ses_e2e02abcdef123456",
      },
      audit: {
        runnerBaseUrl: backEnd.url,
        bearer: backEnd.bearer,
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
