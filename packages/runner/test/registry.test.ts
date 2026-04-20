import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ToolRegistry, loadToolRegistry } from "../src/registry/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "tools.sample.json");

describe("ToolRegistry", () => {
  it("loads the sample fixture", () => {
    const r = loadToolRegistry(FIXTURE);
    expect(r.size()).toBe(4);
    expect(r.names().sort()).toEqual([
      "fs__delete_file",
      "fs__read_file",
      "fs__write_file",
      "net__http_get"
    ]);
  });

  it("lookup returns a copy of the tool entry", () => {
    const r = loadToolRegistry(FIXTURE);
    const writeFile = r.lookup("fs__write_file");
    expect(writeFile?.risk_class).toBe("Mutating");
    expect(writeFile?.default_control).toBe("Prompt");
  });

  it("mustLookup throws on unregistered tool", () => {
    const r = loadToolRegistry(FIXTURE);
    expect(() => r.mustLookup("unknown__tool")).toThrow(/unregistered/);
  });

  it("rejects duplicate tool names", () => {
    expect(
      () =>
        new ToolRegistry([
          { name: "dup", risk_class: "ReadOnly", default_control: "AutoAllow" },
          { name: "dup", risk_class: "ReadOnly", default_control: "AutoAllow" }
        ])
    ).toThrow(/duplicate/);
  });

  it("rejects unknown risk_class", () => {
    expect(
      () =>
        new ToolRegistry([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: "bad", risk_class: "Yolo" as any, default_control: "AutoAllow" }
        ])
    ).toThrow(/risk_class/);
  });

  it("rejects unknown default_control", () => {
    expect(
      () =>
        new ToolRegistry([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: "bad", risk_class: "ReadOnly", default_control: "YoloAllow" as any }
        ])
    ).toThrow(/default_control/);
  });

  it("loadToolRegistry fails cleanly on missing file", () => {
    expect(() => loadToolRegistry("/nonexistent/tools.json")).toThrow(/tools file not found/);
  });
});
