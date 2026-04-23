/**
 * SV-ADAPTER-01 — CardInjection.
 *
 * Asserts that an adapter built via `createLangGraphAdapter(...)` produces
 * an Agent Card whose `adapter_notes.host_framework === "langgraph"` per
 * §18.5.1. Base-card fields MUST be preserved unchanged.
 */

import { describe, it, expect } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createLangGraphAdapter,
  buildAdapterCard,
  HOST_FRAMEWORK,
  ADAPTER_VERSION,
} from "../../src/index.js";

const BASE_CARD = {
  soaHarnessVersion: "1.0",
  name: "conformance-adapter",
  version: "1.0.0",
  description: "Fixture card for SV-ADAPTER-01",
  url: "https://adapter.test",
  protocolVersion: "a2a-0.3",
  agentType: "general-purpose",
  permissions: { activeMode: "ReadOnly", handler: "Interactive" },
  security: { oauthScopes: [], trustAnchors: [] },
};

describe("SV-ADAPTER-01 — CardInjection", () => {
  it("buildAdapterCard overlays adapter_notes.host_framework = \"langgraph\"", () => {
    const card = buildAdapterCard({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
    });
    expect(card).toMatchObject({
      adapter_notes: {
        host_framework: "langgraph",
        permission_mode: "pre-dispatch",
        adapter_version: ADAPTER_VERSION,
      },
    });
  });

  it("host_framework value equals HOST_FRAMEWORK exported constant", () => {
    expect(HOST_FRAMEWORK).toBe("langgraph");
    const card = buildAdapterCard({ baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION });
    expect((card.adapter_notes as { host_framework: string }).host_framework).toBe(HOST_FRAMEWORK);
  });

  it("base card fields are preserved unchanged", () => {
    const card = buildAdapterCard({ baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION });
    expect(card.name).toBe(BASE_CARD.name);
    expect(card.soaHarnessVersion).toBe(BASE_CARD.soaHarnessVersion);
    expect(card.agentType).toBe(BASE_CARD.agentType);
    expect(card.permissions).toEqual(BASE_CARD.permissions);
  });

  it("deferred_test_families is only included when explicitly set", () => {
    const without = buildAdapterCard({ baseCard: BASE_CARD, adapterVersion: ADAPTER_VERSION });
    expect((without.adapter_notes as Record<string, unknown>).deferred_test_families).toBeUndefined();

    const withDeferred = buildAdapterCard({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      deferredTestFamilies: ["SV-MEM", "SV-BUD"],
    });
    expect((withDeferred.adapter_notes as Record<string, unknown>).deferred_test_families).toEqual([
      "SV-MEM",
      "SV-BUD",
    ]);
  });

  it("advisory permission_mode is an opt-in override (§18.5.2 item 4)", () => {
    const card = buildAdapterCard({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      permissionMode: "advisory",
    });
    expect((card.adapter_notes as { permission_mode: string }).permission_mode).toBe("advisory");
  });

  it("createLangGraphAdapter returns a card with adapter_notes populated", () => {
    const echoTool = tool(async () => "ok", {
      name: "echo",
      schema: z.object({ input: z.string() }),
      description: "fixture",
    });
    const adapter = createLangGraphAdapter({
      tools: [echoTool],
      permission: {
        runnerBaseUrl: "http://localhost:7700",
        bearer: "b",
        sessionId: "ses_1",
      },
      audit: {
        runnerBaseUrl: "http://localhost:7700",
        bearer: "b",
        activeMode: "ReadOnly",
      },
      card: {
        baseCard: BASE_CARD,
        adapterVersion: ADAPTER_VERSION,
      },
    });
    expect((adapter.agentCard.adapter_notes as { host_framework: string }).host_framework).toBe(
      "langgraph",
    );
  });
});
