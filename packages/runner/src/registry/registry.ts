import { readFileSync, existsSync } from "node:fs";
import type { ToolEntry, ToolsFile, RiskClass, Control } from "./types.js";

const RISK_CLASSES: readonly RiskClass[] = ["ReadOnly", "Mutating", "Egress", "Destructive"] as const;
const CONTROLS: readonly Control[] = ["AutoAllow", "Prompt", "Deny"] as const;

export class ToolRegistry {
  private readonly byName: Map<string, ToolEntry>;

  constructor(tools: ToolEntry[]) {
    this.byName = new Map();
    for (const t of tools) {
      if (!RISK_CLASSES.includes(t.risk_class)) {
        throw new Error(`ToolRegistry: tool "${t.name}" has unknown risk_class "${t.risk_class}"`);
      }
      if (!CONTROLS.includes(t.default_control)) {
        throw new Error(`ToolRegistry: tool "${t.name}" has unknown default_control "${t.default_control}"`);
      }
      if (this.byName.has(t.name)) {
        throw new Error(`ToolRegistry: duplicate tool name "${t.name}"`);
      }
      this.byName.set(t.name, { ...t });
    }
  }

  lookup(name: string): ToolEntry | undefined {
    return this.byName.get(name);
  }

  mustLookup(name: string): ToolEntry {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`ToolRegistry: unregistered tool "${name}"`);
    return entry;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  size(): number {
    return this.byName.size;
  }
}

export function loadToolRegistry(path: string): ToolRegistry {
  if (!existsSync(path)) {
    throw new Error(`loadToolRegistry: tools file not found at ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolsFile>;
  if (!Array.isArray(parsed.tools)) {
    throw new Error(`loadToolRegistry: ${path} has no "tools" array`);
  }
  return new ToolRegistry(parsed.tools as ToolEntry[]);
}
