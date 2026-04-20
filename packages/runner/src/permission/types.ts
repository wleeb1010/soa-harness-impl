import type { Control, RiskClass, ToolEntry } from "../registry/types.js";
import type { CanonicalDecision } from "../attestation/types.js";

export type Capability = "ReadOnly" | "WorkspaceWrite" | "DangerFullAccess";
export type Handler = "Interactive" | "Coordinator" | "Autonomous";

export type ResolutionDecision = "allow" | "prompt" | "deny";

export type DenyReason =
  | "capability-denied"
  | "control-deny"
  | "prompt-unsatisfied"
  | "autonomous-high-risk";

export interface ResolveInput {
  tool: ToolEntry;
  capability: Capability;
  handler: Handler;
  /** permissions.toolRequirements[tool.name] from the Agent Card (§6.1). */
  toolRequirement?: Control;
  /** A verified §11.4 PDA that already cleared signature / window / CRL checks. */
  verifiedPda?: CanonicalDecision;
}

export interface ResolveOutcome {
  decision: ResolutionDecision;
  /** The control the resolver converged on after tighten-only composition. */
  effectiveControl: Control;
  /** Present when decision is "deny"; identifies which §10.3 gate fired. */
  denyReason?: DenyReason;
  /** Present when decision is "allow"; distinguishes the two audit categories. */
  allowCategory?: "auto-allow" | "prompt-satisfied";
}

/**
 * Thrown when a configuration tries to loosen a control (AutoAllow ← Prompt ← Deny),
 * which Core §10.3 step 3 explicitly rejects. Not a runtime permission outcome —
 * this is a deployment-time error that should surface at Runner startup.
 */
export class ConfigPrecedenceViolation extends Error {
  override readonly name = "ConfigPrecedenceViolation";
  constructor(
    readonly toolName: string,
    readonly registryControl: Control,
    readonly attemptedControl: Control
  ) {
    super(
      `ConfigPrecedenceViolation: tool "${toolName}" — permissions.toolRequirements ` +
        `("${attemptedControl}") tries to loosen the registry default ("${registryControl}"). ` +
        `Core §10.3 step 3 requires AutoAllow → Prompt → Deny (tighten-only).`
    );
  }
}

export const CAPABILITY_PERMITS: Readonly<Record<Capability, readonly RiskClass[]>> = {
  ReadOnly: ["ReadOnly"],
  WorkspaceWrite: ["ReadOnly", "Mutating", "Egress"],
  DangerFullAccess: ["ReadOnly", "Mutating", "Egress", "Destructive"]
};

const CONTROL_RANK: Readonly<Record<Control, number>> = {
  AutoAllow: 0,
  Prompt: 1,
  Deny: 2
};

export function isControlTighteningOrEqual(base: Control, candidate: Control): boolean {
  return CONTROL_RANK[candidate] >= CONTROL_RANK[base];
}
