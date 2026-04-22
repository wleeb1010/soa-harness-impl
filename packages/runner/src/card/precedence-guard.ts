/**
 * §10.3 three-axis precedence guard (Findings AN + AW / SV-CARD-10 +
 * HR-11).
 *
 * The Agent Card carries constraints that stack across three axes:
 *   1. agentType × activeMode — `explore` restricts activeMode to
 *      ReadOnly (§10.3 + §11.2).
 *   2. AGENTS.md denylist × card.toolRequirements — tools denied at
 *      the AGENTS.md layer MUST NOT appear in the card's
 *      toolRequirements allowlist (§11.2).
 *   3. card.toolRequirements[tool] × tool.default_control — step 3 of
 *      §10.3 permits *tightening only* (AutoAllow → Prompt → Deny).
 *      Loosening is `ConfigPrecedenceViolation` (§10.3 step 3 /
 *      HR-11).
 *
 * The runtime resolver (permission/resolver.ts) enforces axis 3 at
 * invocation time; this boot-time guard catches the same violation
 * earlier so the Runner refuses to advertise /ready until the Card is
 * fixed and the ConfigPrecedenceViolation record is observable on
 * /logs/system/recent under BOOT_SESSION_ID.
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

import type { Control } from "../registry/types.js";
import { isControlTighteningOrEqual } from "../permission/types.js";

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
    | "denylist-tool-requirement"
    | "tool-requirement-loosens-default";
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
  /**
   * Per-tool `default_control` lookup from the Tool Registry. When
   * present, axis 3 (§10.3 step 3 / HR-11) checks every entry in
   * `card.permissions.toolRequirements` against the tool's
   * `default_control` and flags any loosening direction. Tools absent
   * from the map are ignored (the registry legitimately may not
   * contain every name the card lists — that's a different fault,
   * caught elsewhere).
   */
  toolDefaultControls?: ReadonlyMap<string, Control>;
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

  // Axis 3 — card.toolRequirements × tool.default_control. §10.3 step 3:
  // overrides MAY only tighten (AutoAllow → Prompt → Deny). Any loosening
  // (e.g. card requirement AutoAllow against registry default Prompt) is
  // ConfigPrecedenceViolation / HR-11. The runtime resolver throws the
  // same class at invocation time; flagging at boot makes the fault
  // observable on /logs/system/recent before any tool call happens.
  if (requirements !== undefined && input.toolDefaultControls !== undefined) {
    const loosened: Array<{ tool: string; default_control: Control; requirement: string }> = [];
    for (const [toolName, requirement] of Object.entries(requirements)) {
      const defaultControl = input.toolDefaultControls.get(toolName);
      if (defaultControl === undefined) continue;
      // Treat requirement as Control. If not a valid Control literal,
      // skip — the card schema validator owns syntactic checks; axis 3
      // only compares semantic ordering.
      if (requirement !== "AutoAllow" && requirement !== "Prompt" && requirement !== "Deny") {
        continue;
      }
      if (!isControlTighteningOrEqual(defaultControl, requirement as Control)) {
        loosened.push({ tool: toolName, default_control: defaultControl, requirement });
      }
    }
    if (loosened.length > 0) {
      violations.push({
        axis: "tool-requirement-loosens-default",
        code: "ConfigPrecedenceViolation",
        message:
          `Agent Card toolRequirements loosen tool default_control ` +
          `(§10.3 step 3 permits tightening only): ` +
          `${loosened
            .map((l) => `"${l.tool}" default=${l.default_control} requirement=${l.requirement}`)
            .join("; ")}`,
        detail: {
          loosened_tools: loosened
        }
      });
    }
  }

  return { violations, ok: violations.length === 0 };
}
