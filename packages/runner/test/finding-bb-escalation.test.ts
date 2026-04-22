import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandlerKeyRegistry,
  EscalationCoordinator,
  parseHandlerEnv,
  assertHandlerEnvListenerSafe,
  HandlerEnvHookOnPublicListener
} from "../src/attestation/index.js";

// Finding BB / §10.4.1 + §10.4.2 — Autonomous escalation coordinator +
// SV-PERM-04 responder kid-role gate.

const FROZEN_NOW = new Date("2026-04-22T12:00:00.000Z");

function makeRegistry(): HandlerKeyRegistry {
  const reg = new HandlerKeyRegistry();
  reg.enroll({
    kid: "interactive-kid",
    spki_hex: "",
    algo: "EdDSA",
    enrolled_at: FROZEN_NOW.toISOString(),
    role: "Interactive"
  });
  reg.enroll({
    kid: "autonomous-kid",
    spki_hex: "",
    algo: "EdDSA",
    enrolled_at: FROZEN_NOW.toISOString(),
    role: "Autonomous"
  });
  reg.enroll({
    kid: "coordinator-kid",
    spki_hex: "",
    algo: "EdDSA",
    enrolled_at: FROZEN_NOW.toISOString(),
    role: "Coordinator"
  });
  return reg;
}

describe("Finding BB — parseHandlerEnv escalation hooks", () => {
  it("parses RUNNER_HANDLER_ESCALATION_TIMEOUT_MS + SOA_HANDLER_ESCALATION_RESPONDER", () => {
    const cfg = parseHandlerEnv({
      RUNNER_HANDLER_ESCALATION_TIMEOUT_MS: "500",
      SOA_HANDLER_ESCALATION_RESPONDER: "/tmp/responder.json"
    });
    expect(cfg.escalationTimeoutMs).toBe(500);
    expect(cfg.responderFilePath).toBe("/tmp/responder.json");
  });

  it("escalation env on non-loopback → HandlerEnvHookOnPublicListener", () => {
    const cfg = parseHandlerEnv({ RUNNER_HANDLER_ESCALATION_TIMEOUT_MS: "100" });
    expect(() =>
      assertHandlerEnvListenerSafe({ env: cfg, host: "0.0.0.0" })
    ).toThrow(HandlerEnvHookOnPublicListener);
  });

  it("responder-only env on non-loopback → HandlerEnvHookOnPublicListener", () => {
    const cfg = parseHandlerEnv({ SOA_HANDLER_ESCALATION_RESPONDER: "/tmp/r.json" });
    expect(() =>
      assertHandlerEnvListenerSafe({ env: cfg, host: "0.0.0.0" })
    ).toThrow(HandlerEnvHookOnPublicListener);
  });
});

describe("Finding BB — EscalationCoordinator", () => {
  it("no responder file → fires timeout after timeoutMs", async () => {
    const reg = makeRegistry();
    const coord = new EscalationCoordinator({
      registry: reg,
      clock: () => FROZEN_NOW,
      timeoutMs: 20
    });
    const out = await coord.awaitResponder();
    expect(out.kind).toBe("timeout");
    expect(out.at).toBe(FROZEN_NOW.toISOString());
  });

  it("Interactive responder approves → kind=approved", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "interactive-kid", response: "approve" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 500,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("approved");
      expect(out.kid).toBe("interactive-kid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Interactive responder denies → kind=denied", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "interactive-kid", response: "deny" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 500,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("denied");
      expect(out.kid).toBe("interactive-kid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Autonomous responder → kind=hitl-required, detail=autonomous-insufficient (SV-PERM-04)", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "autonomous-kid", response: "approve" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 500,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("hitl-required");
      expect(out.detail).toBe("autonomous-insufficient");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Coordinator responder → kind=hitl-required, detail=coordinator-insufficient", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "coordinator-kid", response: "approve" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 500,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("hitl-required");
      expect(out.detail).toBe("coordinator-insufficient");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("silence response → polls continue until timeout", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "interactive-kid", response: "silence" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 100,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("file is truncated after consumption (subsequent writes trigger fresh cycle)", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, JSON.stringify({ kid: "interactive-kid", response: "approve" }));
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 500,
        responderFilePath: file,
        tickMs: 5
      });
      await coord.awaitResponder();
      // After consumption, the file is empty — second awaitResponder
      // with short timeout should end in timeout.
      const coord2 = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 40,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord2.awaitResponder();
      expect(out.kind).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed file → ignored (treated as silence)", async () => {
    const reg = makeRegistry();
    const dir = mkdtempSync(join(tmpdir(), "bb-"));
    const file = join(dir, "r.json");
    try {
      writeFileSync(file, "NOT JSON");
      const coord = new EscalationCoordinator({
        registry: reg,
        clock: () => FROZEN_NOW,
        timeoutMs: 50,
        responderFilePath: file,
        tickMs: 5
      });
      const out = await coord.awaitResponder();
      expect(out.kind).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
