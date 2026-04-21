import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  ToolRegistry,
  loadToolRegistry,
  ToolPoolStale,
  MIN_IDEMPOTENCY_RETENTION_SECONDS,
  type ToolEntry,
  type ToolsFile
} from "../src/registry/index.js";

// §12.2 — tests for the idempotency-retention classification rule.
// Spec fixtures live at `../../../soa-harness=specification/test-vectors/tool-registry-m2/`.

const here = dirname(fileURLToPath(import.meta.url));
const specRoot = join(here, "..", "..", "..", "..", "soa-harness=specification");
const M2_DIR = join(specRoot, "test-vectors", "tool-registry-m2");
const M1_DIR = join(specRoot, "test-vectors", "tool-registry");

const COMPLIANT_ONLY = join(M2_DIR, "tools-compliant-only.json");
const NON_COMPLIANT_ONLY = join(M2_DIR, "tools-non-compliant-only.json");
const COMBINED = join(M2_DIR, "tools.json");
const M1_FIXTURE = join(M1_DIR, "tools.json");

function readTools(path: string): ToolEntry[] {
  return (JSON.parse(readFileSync(path, "utf8")) as ToolsFile).tools;
}

describe("Tool Registry §12.2 idempotency classification", () => {
  it("SV-SESS-05 positive path: compliant-only fixture loads clean", () => {
    const r = loadToolRegistry(COMPLIANT_ONLY);
    expect(r.size()).toBe(1);
    expect(r.names()).toEqual(["compliant_ephemeral_tool"]);
    const entry = r.mustLookup("compliant_ephemeral_tool");
    expect(entry.risk_class).toBe("Destructive");
    expect(entry.default_control).toBe("Prompt");
    expect(entry.idempotency_retention_seconds).toBe(0);
  });

  it("SV-SESS-05 + SV-SESS-11 negative path: non-compliant-only rejects with ToolPoolStale", () => {
    let caught: unknown;
    try {
      loadToolRegistry(NON_COMPLIANT_ONLY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolPoolStale);
    const stale = caught as ToolPoolStale;
    expect(stale.reason).toBe("idempotency-retention-insufficient");
    expect(stale.offendingTool).toBe("non_compliant_ephemeral_tool");
    expect(stale.message).toMatch(/idempotency-retention-insufficient/);
  });

  it("combined M2 fixture rejects on the first non-compliant entry", () => {
    // tools.json orders compliant first, non-compliant second. The compliant
    // entry passes; rejection fires on the second entry without leaking
    // partial state — the whole load fails atomically.
    let caught: unknown;
    try {
      loadToolRegistry(COMBINED);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolPoolStale);
    expect((caught as ToolPoolStale).offendingTool).toBe("non_compliant_ephemeral_tool");
  });

  it("M1 8-tool fixture concatenated with compliant-only loads clean (no idempotency field on M1 entries)", () => {
    // Per §12.2 the classification rule fires only when the field is EXPLICITLY
    // declared < 3600. M1's 8-tool fixture predates the field entirely — absence
    // is treated as "idempotency support adequate" and passes. The compliant
    // M2 entry adds a 9th tool with explicit Destructive+Prompt+retention=0.
    const m1 = readTools(M1_FIXTURE);
    const compliant = readTools(COMPLIANT_ONLY);
    const combined = new ToolRegistry([...m1, ...compliant]);
    expect(combined.size()).toBe(m1.length + 1);
    expect(combined.size()).toBe(9);
    expect(combined.lookup("compliant_ephemeral_tool")?.risk_class).toBe("Destructive");
    expect(combined.lookup("fs__read_file")?.risk_class).toBe("ReadOnly");
  });

  it("field absent → passes regardless of classification (backwards compat)", () => {
    const r = new ToolRegistry([
      { name: "a", risk_class: "ReadOnly", default_control: "AutoAllow" },
      { name: "b", risk_class: "Mutating", default_control: "AutoAllow" },
      { name: "c", risk_class: "Egress", default_control: "Prompt" }
    ]);
    expect(r.size()).toBe(3);
  });

  it("retention >= 3600 with any classification passes", () => {
    const r = new ToolRegistry([
      {
        name: "durable_mutator",
        risk_class: "Mutating",
        default_control: "AutoAllow",
        idempotency_retention_seconds: MIN_IDEMPOTENCY_RETENTION_SECONDS
      }
    ]);
    expect(r.size()).toBe(1);
  });

  it("retention < 3600 + Destructive + non-Prompt default_control → rejected (compliant-but-not-Prompt)", () => {
    // §12.2's second clause: even Destructive tools with low retention MUST be Prompt.
    let caught: unknown;
    try {
      new ToolRegistry([
        {
          name: "destructive_autodeny",
          risk_class: "Destructive",
          default_control: "Deny",
          idempotency_retention_seconds: 120
        }
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolPoolStale);
    expect((caught as ToolPoolStale).offendingTool).toBe("destructive_autodeny");
  });
});
