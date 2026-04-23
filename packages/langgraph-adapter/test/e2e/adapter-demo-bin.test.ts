/**
 * Phase 2.7 smoke test — soa-langgraph-adapter-demo bin sanity.
 *
 * Imports the binary's exported `startAdapterDemo()` instead of spawning
 * a subprocess. Avoids build-order fragility + flaky port-scraping from
 * stdout while still verifying:
 *   - back-end Runner + adapter compose cleanly
 *   - adapter HTTP surface serves /health, /.well-known/agent-card.json
 *     with adapter_notes.host_framework === "langgraph"
 *   - /events/recent is reachable with the demo session bearer
 *   - graceful shutdown unbinds both ports
 */

import { describe, it, expect, afterEach } from "vitest";
import { startAdapterDemo, type AdapterDemoRunning } from "../../src/index.js";

describe("Phase 2.7 — adapter demo binary", () => {
  let running: AdapterDemoRunning | null = null;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
  });

  it("composes back-end + adapter, serves adapter_notes.host_framework = \"langgraph\"", async () => {
    running = await startAdapterDemo({ port: 0 });

    const card = await fetch(`${running.adapterUrl}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);
    const body = (await card.json()) as Record<string, unknown>;
    expect((body.adapter_notes as { host_framework: string }).host_framework).toBe("langgraph");
    expect((body.adapter_notes as { adapter_version: string }).adapter_version).toMatch(/^1\.0\.0-rc/);
  });

  it("adapter /health + back-end /health both return 200", async () => {
    running = await startAdapterDemo({ port: 0 });
    const adapterHealth = await fetch(`${running.adapterUrl}/health`);
    expect(adapterHealth.status).toBe(200);
    const backEndHealth = await fetch(`${running.backEndUrl}/health`);
    expect(backEndHealth.status).toBe(200);
  });

  it("/events/recent is reachable with the default session bearer", async () => {
    running = await startAdapterDemo({ port: 0 });
    const resp = await fetch(
      `${running.adapterUrl}/events/recent?session_id=${running.sessionId}`,
      { headers: { authorization: `Bearer adapter-demo-session-bearer` } },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("custom port + sessionId propagate", async () => {
    running = await startAdapterDemo({
      port: 0,
      sessionId: "ses_adapterdemocustom000001",
      sessionBearer: "custom-bearer",
    });
    expect(running.sessionId).toBe("ses_adapterdemocustom000001");
    const resp = await fetch(
      `${running.adapterUrl}/events/recent?session_id=${running.sessionId}`,
      { headers: { authorization: `Bearer custom-bearer` } },
    );
    expect(resp.status).toBe(200);
  });

  it("close() unbinds both adapter + back-end ports", async () => {
    running = await startAdapterDemo({ port: 0 });
    const { adapterUrl, backEndUrl } = running;
    await running.close();
    running = null;

    // Both URLs should now refuse connections. fetch() will throw or
    // return non-200 depending on OS timing; either is "unbound enough"
    // for this smoke.
    let adapterFailed = false;
    try {
      const r = await fetch(`${adapterUrl}/health`);
      if (!r.ok) adapterFailed = true;
    } catch {
      adapterFailed = true;
    }
    expect(adapterFailed).toBe(true);

    let backEndFailed = false;
    try {
      const r = await fetch(`${backEndUrl}/health`);
      if (!r.ok) backEndFailed = true;
    } catch {
      backEndFailed = true;
    }
    expect(backEndFailed).toBe(true);
  });
});
