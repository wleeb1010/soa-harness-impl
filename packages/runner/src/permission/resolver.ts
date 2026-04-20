import {
  CAPABILITY_PERMITS,
  ConfigPrecedenceViolation,
  isControlTighteningOrEqual,
  type ResolveInput,
  type ResolveOutcome
} from "./types.js";

/**
 * Core §10.3 three-axis permission resolver.
 *
 * Steps (in order):
 *   1. Start with capability = input.capability, control = tool.default_control.
 *   2. Capability gate: deny if tool.risk_class is not permitted under capability
 *      (ReadOnly permits only ReadOnly; WorkspaceWrite permits ReadOnly/Mutating/Egress;
 *      DangerFullAccess permits all). Rejection reason: `capability-denied`.
 *   3. Apply permissions.toolRequirements[tool.name] (if present). This override
 *      MAY only tighten: AutoAllow → Prompt → Deny. Loosening throws
 *      ConfigPrecedenceViolation.
 *   §10.4: an Autonomous handler facing a Destructive tool MUST NOT auto-approve;
 *   in M1 we deny with `autonomous-high-risk` rather than implement the 30-second
 *   escalation-to-Interactive timer (that path is runtime, not resolver, scope).
 *   4. (policyEndpoint tightening — out of M1 scope; caller can chain if desired.)
 *   5. Dispatch by resolved control:
 *        - AutoAllow  → allow / auto-allow
 *        - Prompt     → if a matching verified PDA is present and allow, allow /
 *                       prompt-satisfied; if PDA says deny, deny / prompt-
 *                       unsatisfied; otherwise prompt
 *        - Deny       → deny / control-deny
 */
export function resolvePermission(input: ResolveInput): ResolveOutcome {
  const { tool, capability, handler } = input;

  // Step 2: capability gate
  const permitted = CAPABILITY_PERMITS[capability];
  if (!permitted.includes(tool.risk_class)) {
    return {
      decision: "deny",
      effectiveControl: tool.default_control,
      denyReason: "capability-denied"
    };
  }

  // Step 1 + 3: start from default and apply tighten-only override
  let effectiveControl = tool.default_control;
  if (input.toolRequirement !== undefined) {
    if (!isControlTighteningOrEqual(effectiveControl, input.toolRequirement)) {
      throw new ConfigPrecedenceViolation(tool.name, effectiveControl, input.toolRequirement);
    }
    effectiveControl = input.toolRequirement;
  }

  // §10.4: Autonomous handler MUST NOT auto-approve high-risk actions
  if (handler === "Autonomous" && tool.risk_class === "Destructive") {
    return { decision: "deny", effectiveControl, denyReason: "autonomous-high-risk" };
  }

  // Step 5: dispatch
  if (effectiveControl === "Deny") {
    return { decision: "deny", effectiveControl, denyReason: "control-deny" };
  }
  if (effectiveControl === "AutoAllow") {
    return { decision: "allow", effectiveControl, allowCategory: "auto-allow" };
  }

  // effectiveControl === "Prompt"
  const pda = input.verifiedPda;
  if (pda && pda.tool_name === tool.name) {
    if (pda.decision === "allow") {
      return { decision: "allow", effectiveControl, allowCategory: "prompt-satisfied" };
    }
    return { decision: "deny", effectiveControl, denyReason: "prompt-unsatisfied" };
  }
  return { decision: "prompt", effectiveControl };
}
