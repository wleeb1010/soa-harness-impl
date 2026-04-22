/**
 * §10.3 three-axis precedence guard (Finding AN / SV-CARD-10).
 *
 * The Agent Card carries constraints across three axes — agentType,
 * permissions.activeMode, and AGENTS.md denylist. The lower-precedence
 * axis MUST NOT loosen the upper: an `explore` agentType restricts
 * activeMode to ReadOnly; an AGENTS.md denylist subtracts from the
 * per-session Tool Pool regardless of what toolRequirements permit.
 * A Card that violates those rules MUST be refused at boot.
 *
 * This module returns the full violation list synchronously. Callers
 * decide how to surface the result — start-runner writes a
 * ConfigPrecedenceViolation System Event Log record under the boot
 * session and blocks /ready from flipping to 200, exactly per §5.4 +
 * §14.2 contract.
 *
 * The guard is pure; no IO. Tests cover each violation class
 * exhaustively without touching the boot path.
 */

export interface CardPrecedenceSnapshot {
  agentType?: string;
  permissions?: {
    activeMode?: string;
    toolRequirements?: Record<string, string>;
  };
}

export interface CardPrecedenceViolation {
  axis:
    | "agent-type-activeMode"
    | "denylist-tool-requirement";
  code: "ConfigPrecedenceViolation";
  message: string;
  detail: Record<string, unknown>;
}

export interface CardPrecedenceCheckInput {
  card: CardPrecedenceSnapshot;
  /**
   * Tools listed under `### Deny` in the resolved AGENTS.md file —
   * normalized set of names. Pass an empty set when the Runner is
   * loaded without an AGENTS.md file.
   */
  agentsMdDenied?: ReadonlySet<string>;
}

export interface CardPrecedenceCheckResult {
  violations: readonly CardPrecedenceViolation[];
  ok: boolean;
}

const EXPLORE_MAX_ACTIVE_MODE = "ReadOnly";

export function checkCardPrecedence(
  input: CardPrecedenceCheckInput
): CardPrecedenceCheckResult {
  const violations: CardPrecedenceViolation[] = [];
  const card = input.card;
  const agentType = card.agentType;
  const activeMode = card.permissions?.activeMode;

  // Axis 1 — agentType × activeMode. `explore` is §11.2's deny-all
  // agent type for anything above ReadOnly. Other agentTypes do not
  // pre-clamp activeMode; the three §10.3 tiers all remain reachable.
  if (agentType === "explore" && typeof activeMode === "string" && activeMode !== EXPLORE_MAX_ACTIVE_MODE) {
    violations.push({
      axis: "agent-type-activeMode",
      code: "ConfigPrecedenceViolation",
      message:
        `Agent Card has agentType="explore" with ` +
        `permissions.activeMode="${activeMode}" — §10.3/§11.2 restrict ` +
        `explore agents to activeMode="${EXPLORE_MAX_ACTIVE_MODE}"`,
      detail: {
        agentType,
        activeMode,
        expected_activeMode: EXPLORE_MAX_ACTIVE_MODE
      }
    });
  }

  // Axis 2 — AGENTS.md denylist × card.toolRequirements. Tools that
  // the deployment denies at the AGENTS.md layer MUST NOT appear in
  // the Card's toolRequirements allowlist: the Card is asserting it
  // needs a tool the deployment forbids. §11.2 + §10.3 stacking.
  const requirements = card.permissions?.toolRequirements;
  if (
    input.agentsMdDenied !== undefined &&
    input.agentsMdDenied.size > 0 &&
    requirements !== undefined
  ) {
    const collided: string[] = [];
    for (const toolName of Object.keys(requirements)) {
      if (input.agentsMdDenied.has(toolName)) collided.push(toolName);
    }
    if (collided.length > 0) {
      violations.push({
        axis: "denylist-tool-requirement",
        code: "ConfigPrecedenceViolation",
        message:
          `Agent Card toolRequirements list tools denied by AGENTS.md: ` +
          `${collided.map((t) => `"${t}"`).join(", ")}`,
        detail: {
          denied_tools: collided,
          agents_md_deny_count: input.agentsMdDenied.size,
          card_requirement_count: Object.keys(requirements).length
        }
      });
    }
  }

  return { violations, ok: violations.length === 0 };
}
