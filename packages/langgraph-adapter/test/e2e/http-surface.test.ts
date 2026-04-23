/**
 * Phase 2.5 E2E — adapter HTTP surface.
 *
 * Spins up `startLangGraphAdapterRunner` on a random port, makes real
 * HTTP requests (not .inject()) to the agent-card / health / ready
 * endpoints, and asserts:
 *   - SV-ADAPTER-01 CardInjection over a real HTTP round-trip
 *   - §5 Required Stack surface basics: /health, /ready return 200
 *   - Detached JWS ships at /.well-known/agent-card.jws (§5.1)
 *
 * Out of scope for this file (Phase 2.6+ follow-up):
 *   - Live LangGraph-driven tool dispatch + permission round-trip to a
 *     mocked back-end Runner
 *   - /events/recent populated from adapter.EventMapper
 *   - Audit-chain integrity verification end-to-end
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startLangGraphAdapterRunner, ADAPTER_VERSION } from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_CARD: Record<string, unknown> = {
  soaHarnessVersion: "1.0",
  name: "e2e-adapter",
  version: "1.0.0",
  description: "Phase 2.5 e2e fixture card",
  url: "https://adapter.test",
  protocolVersion: "a2a-0.3",
  agentType: "general-purpose",
  permissions: { activeMode: "ReadOnly", handler: "Interactive" },
  security: {
    oauthScopes: [],
    trustAnchors: [
      {
        issuer: "CN=SOA-Harness Adapter Self-Signed, O=Test",
        spki_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        uri: "https://ca.local/",
        publisher_kid: "soa-langgraph-adapter-demo",
      },
    ],
  },
};

function loadTrust() {
  // Vendored inline rather than reading from the sibling @soa-harness/runner
  // test fixtures dir — keeps this e2e test self-contained.
  return {
    soaHarnessVersion: "1.0" as const,
    publisher_kid: "soa-release-v1.0",
    spki_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    issuer: "CN=Test CA, O=SOA-Test, C=US",
    issued_at: "2026-01-01T00:00:00Z",
    channel: "sdk-pinned" as const,
  };
}

async function fetchText(url: string): Promise<{ status: number; body: string; headers: Headers }> {
  const r = await fetch(url);
  return { status: r.status, body: await r.text(), headers: r.headers };
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const r = await fetch(url);
  const body = await r.text();
  return { status: r.status, body: body.length ? JSON.parse(body) : null, headers: r.headers };
}

describe("Phase 2.5 — adapter HTTP surface", () => {
  it("GET /.well-known/agent-card.json returns adapter_notes.host_framework = \"langgraph\"", async () => {
    const server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0, // OS-assigned
    });
    try {
      const { port } = server.address;
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(status).toBe(200);
      const card = body as Record<string, unknown>;
      expect((card.adapter_notes as { host_framework: string }).host_framework).toBe("langgraph");
      expect((card.adapter_notes as { permission_mode: string }).permission_mode).toBe("pre-dispatch");
      expect((card.adapter_notes as { adapter_version: string }).adapter_version).toBe(ADAPTER_VERSION);
      // Base-card fields preserved:
      expect(card.name).toBe(BASE_CARD.name);
      expect(card.protocolVersion).toBe("a2a-0.3");
    } finally {
      await server.close();
    }
  });

  it("GET /health and /ready return 200", async () => {
    const server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0,
    });
    try {
      const { port } = server.address;
      const health = await fetchJson(`http://127.0.0.1:${port}/health`);
      const ready = await fetchJson(`http://127.0.0.1:${port}/ready`);
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("GET /.well-known/agent-card.jws returns a detached JWS (§5.1 shorthand)", async () => {
    const server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0,
    });
    try {
      const { port } = server.address;
      const { status, body, headers } = await fetchText(
        `http://127.0.0.1:${port}/.well-known/agent-card.jws`,
      );
      expect(status).toBe(200);
      expect(headers.get("content-type")).toMatch(/application\/jose/);
      // Detached form per RFC 7515 Appendix F: "h..s" — middle segment empty.
      const segments = body.split(".");
      expect(segments).toHaveLength(3);
      expect(segments[1]).toBe("");
    } finally {
      await server.close();
    }
  });

  it("JSON + JWS responses share the same ETag (byte-identity of signed body)", async () => {
    const server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0,
    });
    try {
      const { port } = server.address;
      const json = await fetchText(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      const jws = await fetchText(`http://127.0.0.1:${port}/.well-known/agent-card.jws`);
      expect(json.headers.get("etag")).toBe(jws.headers.get("etag"));
      expect(json.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    } finally {
      await server.close();
    }
  });

  it("custom adapterNotesOverrides propagate to the served card", async () => {
    const server = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0,
      adapterNotesOverrides: {
        adapterVersion: ADAPTER_VERSION,
        baseCard: BASE_CARD,
        deferredTestFamilies: ["SV-MEM", "SV-BUD"],
      },
    });
    try {
      const { port } = server.address;
      const { body } = await fetchJson(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      const notes = (body as { adapter_notes: Record<string, unknown> }).adapter_notes;
      expect(notes.deferred_test_families).toEqual(["SV-MEM", "SV-BUD"]);
    } finally {
      await server.close();
    }
  });

  it("close() unbinds the port (second startup on same port would succeed)", async () => {
    const s1 = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: 0,
    });
    const firstPort = s1.address.port;
    await s1.close();
    // Rebind the exact port — if close didn't unbind, this would EADDRINUSE.
    const s2 = await startLangGraphAdapterRunner({
      baseCard: BASE_CARD,
      adapterVersion: ADAPTER_VERSION,
      trust: loadTrust(),
      port: firstPort,
    });
    try {
      expect(s2.address.port).toBe(firstPort);
    } finally {
      await s2.close();
    }
  });
});
