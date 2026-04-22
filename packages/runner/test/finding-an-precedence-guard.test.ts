import { describe, it, expect } from "vitest";
import { checkCardPrecedence } from "../src/card/index.js";

// Finding AN / SV-CARD-10 — §10.3 three-axis precedence guard.

describe("Finding AN — checkCardPrecedence", () => {
  it("compliant card: no violations", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "general-purpose",
        permissions: { activeMode: "WorkspaceWrite" }
      }
    });
    expect(out.ok).toBe(true);
    expect(out.violations.length).toBe(0);
  });

  it("explore agentType + DangerFullAccess → ConfigPrecedenceViolation", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "explore",
        permissions: { activeMode: "DangerFullAccess" }
      }
    });
    expect(out.ok).toBe(false);
    expect(out.violations.length).toBe(1);
    expect(out.violations[0]?.code).toBe("ConfigPrecedenceViolation");
    expect(out.violations[0]?.axis).toBe("agent-type-activeMode");
    expect(out.violations[0]?.message).toMatch(/agentType="explore"/);
    expect(out.violations[0]?.detail["agentType"]).toBe("explore");
    expect(out.violations[0]?.detail["activeMode"]).toBe("DangerFullAccess");
    expect(out.violations[0]?.detail["expected_activeMode"]).toBe("ReadOnly");
  });

  it("explore agentType + WorkspaceWrite → violation (still loosens above ReadOnly)", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "explore",
        permissions: { activeMode: "WorkspaceWrite" }
      }
    });
    expect(out.ok).toBe(false);
    expect(out.violations[0]?.axis).toBe("agent-type-activeMode");
  });

  it("explore + ReadOnly → compliant", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "explore",
        permissions: { activeMode: "ReadOnly" }
      }
    });
    expect(out.ok).toBe(true);
  });

  it("general-purpose + DangerFullAccess → compliant (no agentType precedence)", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "general-purpose",
        permissions: { activeMode: "DangerFullAccess" }
      }
    });
    expect(out.ok).toBe(true);
  });

  it("AGENTS.md denies a tool the card requires → ConfigPrecedenceViolation", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "general-purpose",
        permissions: {
          activeMode: "WorkspaceWrite",
          toolRequirements: { "fs__write_file": "AutoAllow", "shell__run": "Prompt" }
        }
      },
      agentsMdDenied: new Set(["fs__write_file"])
    });
    expect(out.ok).toBe(false);
    expect(out.violations.length).toBe(1);
    expect(out.violations[0]?.axis).toBe("denylist-tool-requirement");
    expect(out.violations[0]?.code).toBe("ConfigPrecedenceViolation");
    expect(out.violations[0]?.detail["denied_tools"]).toEqual(["fs__write_file"]);
  });

  it("AGENTS.md denylist + compliant agentType = report all violations", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "explore",
        permissions: {
          activeMode: "DangerFullAccess",
          toolRequirements: { "fs__write_file": "AutoAllow" }
        }
      },
      agentsMdDenied: new Set(["fs__write_file"])
    });
    expect(out.ok).toBe(false);
    expect(out.violations.length).toBe(2);
    const axes = out.violations.map((v) => v.axis).sort();
    expect(axes).toEqual(["agent-type-activeMode", "denylist-tool-requirement"]);
  });

  it("empty denylist + no toolRequirements → no axis-2 check", () => {
    const out = checkCardPrecedence({
      card: {
        agentType: "general-purpose",
        permissions: { activeMode: "ReadOnly" }
      },
      agentsMdDenied: new Set()
    });
    expect(out.ok).toBe(true);
  });

  it("missing agentType leaves axis-1 inert (pre-1.0 fixtures)", () => {
    const out = checkCardPrecedence({
      card: { permissions: { activeMode: "WorkspaceWrite" } }
    });
    expect(out.ok).toBe(true);
  });
});
