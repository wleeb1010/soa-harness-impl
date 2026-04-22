import { describe, it, expect } from "vitest";
import { checkCardPrecedence } from "../src/card/index.js";
import type { Control } from "../src/registry/types.js";

// Finding AW / HR-11 — §10.3 step 3 axis-3 boot-time precedence guard.
// card.toolRequirements[tool] MAY only tighten against the registry's
// tool.default_control. Loosening flags ConfigPrecedenceViolation under
// axis "tool-requirement-loosens-default".

describe("Finding AW — precedence-guard axis 3 (toolRequirements × default_control)", () => {
  it("requirement equal to default → no violation (tight-equal allowed)", () => {
    const defaults = new Map<string, Control>([["mcp__fs__read", "Prompt"]]);
    const out = checkCardPrecedence({
      card: {
        agentType: "general-purpose",
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__fs__read: "Prompt" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(true);
  });

  it("requirement tightens default (AutoAllow → Prompt) → no violation", () => {
    const defaults = new Map<string, Control>([["mcp__fs__read", "AutoAllow"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__fs__read: "Prompt" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(true);
  });

  it("requirement tightens default (Prompt → Deny) → no violation", () => {
    const defaults = new Map<string, Control>([["mcp__shell__exec", "Prompt"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__shell__exec: "Deny" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(true);
  });

  it("requirement loosens default (Prompt → AutoAllow) → ConfigPrecedenceViolation", () => {
    const defaults = new Map<string, Control>([["mcp__shell__exec", "Prompt"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__shell__exec: "AutoAllow" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(false);
    expect(out.violations.length).toBe(1);
    const v = out.violations[0]!;
    expect(v.code).toBe("ConfigPrecedenceViolation");
    expect(v.axis).toBe("tool-requirement-loosens-default");
    expect(v.message).toMatch(/§10\.3 step 3/);
    expect(v.message).toMatch(/mcp__shell__exec/);
    expect(v.detail["loosened_tools"]).toEqual([
      { tool: "mcp__shell__exec", default_control: "Prompt", requirement: "AutoAllow" }
    ]);
  });

  it("requirement loosens default (Deny → Prompt) → ConfigPrecedenceViolation", () => {
    const defaults = new Map<string, Control>([["mcp__fs__delete", "Deny"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "DangerFullAccess",
          toolRequirements: { mcp__fs__delete: "Prompt" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(false);
    expect(out.violations[0]?.axis).toBe("tool-requirement-loosens-default");
  });

  it("requirement loosens default (Deny → AutoAllow) → ConfigPrecedenceViolation", () => {
    const defaults = new Map<string, Control>([["mcp__fs__delete", "Deny"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "DangerFullAccess",
          toolRequirements: { mcp__fs__delete: "AutoAllow" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(false);
  });

  it("multiple loosening tools aggregate into one violation with full list", () => {
    const defaults = new Map<string, Control>([
      ["mcp__fs__read", "Prompt"],
      ["mcp__fs__write", "Prompt"],
      ["mcp__shell__exec", "Deny"]
    ]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: {
            mcp__fs__read: "AutoAllow",
            mcp__fs__write: "Prompt",
            mcp__shell__exec: "Prompt"
          }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(false);
    expect(out.violations.length).toBe(1);
    const detail = out.violations[0]!.detail["loosened_tools"] as Array<{ tool: string }>;
    expect(detail.map((d) => d.tool).sort()).toEqual(["mcp__fs__read", "mcp__shell__exec"]);
  });

  it("tool in requirements but absent from defaults map → ignored (different fault class)", () => {
    const defaults = new Map<string, Control>();
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__fs__unknown: "AutoAllow" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(true);
  });

  it("toolDefaultControls absent → axis 3 is skipped (back-compat with callers pre-AW)", () => {
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__shell__exec: "AutoAllow" }
        }
      }
    });
    expect(out.ok).toBe(true);
  });

  it("invalid Control literal in requirements → skipped (schema validator owns syntax)", () => {
    const defaults = new Map<string, Control>([["mcp__fs__read", "Prompt"]]);
    const out = checkCardPrecedence({
      card: {
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { mcp__fs__read: "NotAControl" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(true);
  });

  it("axis 3 composes with axis 1 — both violations surface", () => {
    const defaults = new Map<string, Control>([["mcp__fs__delete", "Deny"]]);
    const out = checkCardPrecedence({
      card: {
        agentType: "explore",
        permissions: {
          activeMode: "DangerFullAccess",
          toolRequirements: { mcp__fs__delete: "AutoAllow" }
        }
      },
      toolDefaultControls: defaults
    });
    expect(out.ok).toBe(false);
    const axes = out.violations.map((v) => v.axis).sort();
    expect(axes).toEqual(["agent-type-activeMode", "tool-requirement-loosens-default"]);
  });
});
