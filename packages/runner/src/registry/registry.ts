import { readFileSync, existsSync } from "node:fs";
import { ToolPoolStale } from "./types.js";
import type { ToolEntry, ToolsFile, RiskClass, Control } from "./types.js";

const RISK_CLASSES: readonly RiskClass[] = ["ReadOnly", "Mutating", "Egress", "Destructive"] as const;
const CONTROLS: readonly Control[] = ["AutoAllow", "Prompt", "Deny"] as const;

/**
 * §12.2 minimum idempotency retention. Tools declaring a retention window
 * below this threshold MUST be classified Destructive + Prompt or the
 * Runner rejects them at Tool Registry assembly.
 */
export const MIN_IDEMPOTENCY_RETENTION_SECONDS = 3600;

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
      assertIdempotencyClassification(t);
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

  /**
   * §11.3.1 dynamic-add entry point. Stamps _registered_at +
   * _registration_source="mcp-dynamic" on the entry. Re-runs the §12.2
   * idempotency-classification check so a bad dynamic add fails the same
   * way a bad static fixture does.
   *
   * Returns true when the entry was added; false when a tool with the
   * same name already exists (no-op — §11 name uniqueness).
   */
  addDynamic(entry: ToolEntry, registeredAt: Date): boolean {
    if (!RISK_CLASSES.includes(entry.risk_class)) {
      throw new Error(`ToolRegistry: dynamic add "${entry.name}" has unknown risk_class "${entry.risk_class}"`);
    }
    if (!CONTROLS.includes(entry.default_control)) {
      throw new Error(`ToolRegistry: dynamic add "${entry.name}" has unknown default_control "${entry.default_control}"`);
    }
    if (this.byName.has(entry.name)) return false;
    assertIdempotencyClassification(entry);
    const stamped: ToolEntry = {
      ...entry,
      _registered_at: registeredAt.toISOString(),
      _registration_source: "mcp-dynamic"
    };
    this.byName.set(entry.name, stamped);
    return true;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  size(): number {
    return this.byName.size;
  }
}

/**
 * §12.2 enforcement. When a tool entry declares `idempotency_retention_seconds`
 * explicitly AND below the 3600-second minimum, the entry MUST additionally
 * be classified Destructive + Prompt. Absence of the field is treated as
 * "idempotency support adequate for this risk_class" and passes cleanly.
 *
 * Any violation throws `ToolPoolStale` with reason `idempotency-retention-insufficient`.
 * The first offending entry in load order terminates the registry load — callers
 * (start-runner bin) turn this into a non-zero exit without opening any listener.
 */
function assertIdempotencyClassification(t: ToolEntry): void {
  const retention = t.idempotency_retention_seconds;
  if (retention === undefined || retention === null) return;
  if (retention >= MIN_IDEMPOTENCY_RETENTION_SECONDS) return;
  if (t.risk_class === "Destructive" && t.default_control === "Prompt") return;
  throw new ToolPoolStale(t.name, "idempotency-retention-insufficient");
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
