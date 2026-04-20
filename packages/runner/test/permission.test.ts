import { describe, it, expect } from "vitest";
import {
  resolvePermission,
  ConfigPrecedenceViolation,
  type Capability,
  type Handler
} from "../src/permission/index.js";
import type { ToolEntry } from "../src/registry/types.js";
import type { CanonicalDecision } from "../src/attestation/types.js";

function tool(partial: Partial<ToolEntry> & { name: string }): ToolEntry {
  return {
    risk_class: "ReadOnly",
    default_control: "AutoAllow",
    ...partial
  } as ToolEntry;
}

function pda(partial: Partial<CanonicalDecision> = {}): CanonicalDecision {
  return {
    prompt_id: "prm_abc",
    session_id: "ses_xyz",
    tool_name: "fs__write_file",
    args_digest: "sha256:deadbeef",
    decision: "allow",
    scope: "once",
    not_before: "2026-04-18T12:01:05.000Z",
    not_after: "2026-04-18T12:05:30.000Z",
    nonce: "nonce",
    handler_kid: "kid-handler-2026",
    ...partial
  };
}

describe("resolvePermission — capability gate (§10.3 step 2)", () => {
  it("denies Destructive under ReadOnly", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }),
      capability: "ReadOnly",
      handler: "Interactive"
    });
    expect(out).toMatchObject({ decision: "deny", denyReason: "capability-denied" });
  });

  it("denies Destructive under WorkspaceWrite", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive"
    });
    expect(out.decision).toBe("deny");
    expect(out.denyReason).toBe("capability-denied");
  });

  it("permits Destructive under DangerFullAccess", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }),
      capability: "DangerFullAccess",
      handler: "Interactive"
    });
    expect(out.decision).toBe("prompt");
  });

  it("permits Mutating under WorkspaceWrite", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive"
    });
    expect(out.decision).toBe("prompt");
  });
});

describe("resolvePermission — default_control dispatch (§10.3 step 5)", () => {
  it("AutoAllow → allow / auto-allow", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }),
      capability: "ReadOnly",
      handler: "Interactive"
    });
    expect(out).toEqual({
      decision: "allow",
      effectiveControl: "AutoAllow",
      allowCategory: "auto-allow"
    });
  });

  it("Deny → deny / control-deny", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__read_file", risk_class: "ReadOnly", default_control: "Deny" }),
      capability: "ReadOnly",
      handler: "Interactive"
    });
    expect(out.decision).toBe("deny");
    expect(out.denyReason).toBe("control-deny");
  });

  it("Prompt without PDA → prompt", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive"
    });
    expect(out.decision).toBe("prompt");
  });

  it("Prompt + matching allow PDA → allow / prompt-satisfied", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive",
      verifiedPda: pda({ tool_name: "fs__write_file", decision: "allow" })
    });
    expect(out.decision).toBe("allow");
    expect(out.allowCategory).toBe("prompt-satisfied");
  });

  it("Prompt + deny PDA → deny / prompt-unsatisfied", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive",
      verifiedPda: pda({ tool_name: "fs__write_file", decision: "deny" })
    });
    expect(out.decision).toBe("deny");
    expect(out.denyReason).toBe("prompt-unsatisfied");
  });

  it("Prompt + PDA for a different tool does NOT satisfy (still prompts)", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive",
      verifiedPda: pda({ tool_name: "fs__read_file", decision: "allow" })
    });
    expect(out.decision).toBe("prompt");
  });
});

describe("resolvePermission — tighten-only override (§10.3 step 3)", () => {
  it("AutoAllow → Prompt is accepted", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }),
      capability: "ReadOnly",
      handler: "Interactive",
      toolRequirement: "Prompt"
    });
    expect(out.effectiveControl).toBe("Prompt");
    expect(out.decision).toBe("prompt");
  });

  it("AutoAllow → Deny is accepted", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }),
      capability: "ReadOnly",
      handler: "Interactive",
      toolRequirement: "Deny"
    });
    expect(out.decision).toBe("deny");
    expect(out.denyReason).toBe("control-deny");
  });

  it("Prompt → AutoAllow is rejected (ConfigPrecedenceViolation)", () => {
    expect(() =>
      resolvePermission({
        tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
        capability: "WorkspaceWrite",
        handler: "Interactive",
        toolRequirement: "AutoAllow"
      })
    ).toThrow(ConfigPrecedenceViolation);
  });

  it("Deny → Prompt is rejected", () => {
    expect(() =>
      resolvePermission({
        tool: tool({ name: "fs__read_file", risk_class: "ReadOnly", default_control: "Deny" }),
        capability: "ReadOnly",
        handler: "Interactive",
        toolRequirement: "Prompt"
      })
    ).toThrow(ConfigPrecedenceViolation);
  });

  it("same-value override (Prompt → Prompt) is fine", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "Prompt" }),
      capability: "WorkspaceWrite",
      handler: "Interactive",
      toolRequirement: "Prompt"
    });
    expect(out.decision).toBe("prompt");
  });
});

describe("resolvePermission — §10.4 autonomous high-risk", () => {
  it("Autonomous + Destructive → deny / autonomous-high-risk", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }),
      capability: "DangerFullAccess",
      handler: "Autonomous"
    });
    expect(out.decision).toBe("deny");
    expect(out.denyReason).toBe("autonomous-high-risk");
  });

  it("Interactive + Destructive → prompt (not auto-denied)", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__delete_file", risk_class: "Destructive", default_control: "Prompt" }),
      capability: "DangerFullAccess",
      handler: "Interactive"
    });
    expect(out.decision).toBe("prompt");
  });

  it("Autonomous + Mutating (not high-risk) → permitted", () => {
    const out = resolvePermission({
      tool: tool({ name: "fs__write_file", risk_class: "Mutating", default_control: "AutoAllow" }),
      capability: "WorkspaceWrite",
      handler: "Autonomous"
    });
    expect(out.decision).toBe("allow");
  });
});

describe("resolvePermission — sweep over all 27 (capability × handler × control) tuples", () => {
  it("every tuple produces a structurally complete ResolveOutcome", () => {
    const capabilities: Capability[] = ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"];
    const handlers: Handler[] = ["Interactive", "Coordinator", "Autonomous"];
    const controls = ["AutoAllow", "Prompt", "Deny"] as const;
    for (const capability of capabilities) {
      for (const handler of handlers) {
        for (const control of controls) {
          const out = resolvePermission({
            tool: tool({ name: "probe", risk_class: "ReadOnly", default_control: control }),
            capability,
            handler
          });
          expect(out.decision).toBeDefined();
          expect(out.effectiveControl).toBe(control);
        }
      }
    }
  });
});
