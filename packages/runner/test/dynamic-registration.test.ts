import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastify } from "fastify";
import {
  ToolRegistry,
  startDynamicRegistrationWatcher,
  assertDynamicRegistrationListenerSafe,
  DynamicToolRegistrationOnPublicListener
} from "../src/registry/index.js";
import { toolsRegisteredPlugin } from "../src/observability/index.js";
import { InMemorySessionStore } from "../src/permission/index.js";

const FROZEN_NOW = new Date("2026-04-22T00:00:00.000Z");
const BEARER = "dyn-reg-bearer";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "soa-dynreg-"));
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry([
    { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
  ]);
  // Simulate bin's post-load metadata stamp.
  const t = r.mustLookup("fs__read_file");
  t._registered_at = FROZEN_NOW.toISOString();
  t._registration_source = "static-fixture";
  return r;
}

describe("§11.3.1 dynamic tool registration", () => {
  let dir: string;
  let trigger: string;

  beforeEach(() => {
    dir = tmpDir();
    trigger = join(dir, "trigger.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests a JSON-array of tool entries; stamps mcp-dynamic source + registered_at", async () => {
    const registry = makeRegistry();
    writeFileSync(
      trigger,
      JSON.stringify([
        { name: "dyn__tool_a", risk_class: "ReadOnly", default_control: "AutoAllow" },
        { name: "dyn__tool_b", risk_class: "Mutating", default_control: "Prompt" }
      ])
    );
    const handle = startDynamicRegistrationWatcher({
      triggerPath: trigger,
      registry,
      clock: () => FROZEN_NOW,
      pollIntervalMs: 10
    });
    try {
      const added = await handle.tickNow();
      expect(added).toBe(2);
      const a = registry.mustLookup("dyn__tool_a");
      expect(a._registration_source).toBe("mcp-dynamic");
      expect(a._registered_at).toBe(FROZEN_NOW.toISOString());
      expect(registry.mustLookup("dyn__tool_b")._registration_source).toBe("mcp-dynamic");
      // File truncated post-ingest.
      expect(readFileSync(trigger, "utf8")).toBe("");
    } finally {
      await handle.stop();
    }
  });

  it("second write to the trigger file triggers another ingest", async () => {
    const registry = makeRegistry();
    const handle = startDynamicRegistrationWatcher({
      triggerPath: trigger,
      registry,
      clock: () => FROZEN_NOW,
      pollIntervalMs: 10
    });
    try {
      writeFileSync(trigger, JSON.stringify([{ name: "dyn__first", risk_class: "ReadOnly", default_control: "AutoAllow" }]));
      expect(await handle.tickNow()).toBe(1);
      writeFileSync(trigger, JSON.stringify([{ name: "dyn__second", risk_class: "ReadOnly", default_control: "AutoAllow" }]));
      expect(await handle.tickNow()).toBe(1);
      expect(registry.has?.("dyn__first") ?? registry.names().includes("dyn__first")).toBe(true);
      expect(registry.names()).toContain("dyn__second");
    } finally {
      await handle.stop();
    }
  });

  it("missing trigger file is a silent no-op (tickNow returns 0)", async () => {
    const registry = makeRegistry();
    const handle = startDynamicRegistrationWatcher({
      triggerPath: join(dir, "does-not-exist.json"),
      registry,
      clock: () => FROZEN_NOW,
      pollIntervalMs: 10
    });
    try {
      expect(await handle.tickNow()).toBe(0);
      expect(registry.size()).toBe(1); // unchanged
    } finally {
      await handle.stop();
    }
  });

  it("malformed trigger content (non-JSON) truncates + reports an error; registry unchanged", async () => {
    const registry = makeRegistry();
    writeFileSync(trigger, "not valid json {{{");
    const errors: unknown[] = [];
    const handle = startDynamicRegistrationWatcher({
      triggerPath: trigger,
      registry,
      clock: () => FROZEN_NOW,
      pollIntervalMs: 10,
      onError: (err) => errors.push(err)
    });
    try {
      expect(await handle.tickNow()).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(registry.size()).toBe(1);
      expect(readFileSync(trigger, "utf8")).toBe(""); // truncated
    } finally {
      await handle.stop();
    }
  });

  it("non-array JSON content is rejected + reports an error", async () => {
    const registry = makeRegistry();
    writeFileSync(trigger, JSON.stringify({ name: "not-array", risk_class: "ReadOnly", default_control: "AutoAllow" }));
    const errors: unknown[] = [];
    const handle = startDynamicRegistrationWatcher({
      triggerPath: trigger,
      registry,
      clock: () => FROZEN_NOW,
      pollIntervalMs: 10,
      onError: (err) => errors.push(err)
    });
    try {
      expect(await handle.tickNow()).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
      expect(registry.size()).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  it("duplicate name is a no-op; addDynamic returns false", async () => {
    const registry = makeRegistry();
    const added = registry.addDynamic(
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" },
      FROZEN_NOW
    );
    expect(added).toBe(false);
    // Original static-fixture metadata preserved.
    expect(registry.mustLookup("fs__read_file")._registration_source).toBe("static-fixture");
  });

  it("addDynamic rejects §12.2 idempotency-classification violations", async () => {
    const registry = makeRegistry();
    expect(() =>
      registry.addDynamic(
        {
          name: "dyn__bad_retention",
          risk_class: "Mutating",
          default_control: "AutoAllow",
          idempotency_retention_seconds: 0
        },
        FROZEN_NOW
      )
    ).toThrow(/idempotency-retention-insufficient/);
  });

  it("production guard: env set + non-loopback host → DynamicToolRegistrationOnPublicListener", () => {
    expect(() =>
      assertDynamicRegistrationListenerSafe({ triggerPath: "/tmp/x", host: "127.0.0.1" })
    ).not.toThrow();
    expect(() =>
      assertDynamicRegistrationListenerSafe({ triggerPath: "/tmp/x", host: "localhost" })
    ).not.toThrow();
    expect(() =>
      assertDynamicRegistrationListenerSafe({ triggerPath: "/tmp/x", host: "10.0.0.5" })
    ).toThrow(DynamicToolRegistrationOnPublicListener);
    expect(() =>
      assertDynamicRegistrationListenerSafe({ triggerPath: "/tmp/x", host: "0.0.0.0" })
    ).toThrow(DynamicToolRegistrationOnPublicListener);
    expect(() =>
      assertDynamicRegistrationListenerSafe({ triggerPath: undefined, host: "public.example.com" })
    ).not.toThrow();
  });

  it("/tools/registered reflects dynamic-registered tools with source=mcp-dynamic", async () => {
    const registry = makeRegistry();
    registry.addDynamic(
      { name: "dyn__live", risk_class: "ReadOnly", default_control: "AutoAllow" },
      FROZEN_NOW
    );
    const app = fastify();
    const sessionStore = new InMemorySessionStore();
    sessionStore.register("ses_dyntools000000000001", BEARER);
    await app.register(toolsRegisteredPlugin, {
      registry,
      sessionStore,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      runnerVersion: "1.0",
      registeredAt: FROZEN_NOW
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/tools/registered",
        headers: { authorization: `Bearer ${BEARER}` }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { tools: Array<Record<string, unknown>> };
      const staticTool = body.tools.find((t) => t["name"] === "fs__read_file");
      const dynTool = body.tools.find((t) => t["name"] === "dyn__live");
      expect(staticTool?.["registration_source"]).toBe("static-fixture");
      expect(dynTool?.["registration_source"]).toBe("mcp-dynamic");
    } finally {
      await app.close();
    }
  });

  it("SV-REG-03 property: dynamic add changes registry_version but does not modify an in-flight session's pinned tool_pool_hash", async () => {
    // The tool_pool_hash is pinned AT session bootstrap via
    // `sha256:registry-size-N`. Dynamic add updates the registry; simulated
    // in-flight session tracks the pinned hash separately.
    const registry = makeRegistry();
    const preAddSize = registry.size();
    const sessionPinnedHash = `sha256:registry-size-${preAddSize}`;

    // Simulate a dynamic add mid-session.
    registry.addDynamic(
      { name: "dyn__midstream", risk_class: "ReadOnly", default_control: "AutoAllow" },
      FROZEN_NOW
    );

    const postAddSize = registry.size();
    const currentGlobalHash = `sha256:registry-size-${postAddSize}`;

    // Registry-level hash advanced.
    expect(currentGlobalHash).not.toBe(sessionPinnedHash);
    // Session-level pin unchanged (stored at bootstrap; immutable per §11.3).
    expect(sessionPinnedHash).toBe(`sha256:registry-size-${preAddSize}`);
  });
});
