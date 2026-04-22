/**
 * Per Core §11 risk-class enumeration (closed set — extending is a spec change).
 */
export type RiskClass = "ReadOnly" | "Mutating" | "Egress" | "Destructive";

/**
 * Per §10.3 control axis (closed set).
 */
export type Control = "AutoAllow" | "Prompt" | "Deny";

export interface ToolEntry {
  name: string;
  risk_class: RiskClass;
  default_control: Control;
  description?: string;
  /**
   * Seconds the Runner is willing to retain idempotency evidence for this tool (§12.2).
   * When explicitly declared AND below the §12.2 `MIN_IDEMPOTENCY_RETENTION_SECONDS`
   * threshold (3600s), the tool MUST be classified `Destructive` + `Prompt` or the
   * Runner rejects it at Tool Registry load with `ToolPoolStale`
   * reason=`idempotency-retention-insufficient`. Absence of the field is treated
   * as "idempotency support is adequate for this risk_class" — the pre-M2 fixture
   * surface (which predates the field) keeps loading cleanly.
   */
  idempotency_retention_seconds?: number;
  /**
   * §11.4 per-tool registration metadata. Non-normative on disk (tools.json
   * fixtures don't carry these) but populated at load time so /tools/registered
   * can surface both `registered_at` + `registration_source`.
   */
  _registered_at?: string;
  _registration_source?: "static-fixture" | "mcp-dynamic";
}

export interface ToolsFile {
  $schema?: string;
  tools: ToolEntry[];
}

/**
 * Closed-set reason enum for ToolPoolStale rejections.
 *   - `idempotency-retention-insufficient` — §12.2 load-time classification
 *     rule (tool declaring `< 3600` retention without Destructive+Prompt).
 *   - `tool-pool-hash-mismatch` — §12.5 step 3 resume check: the session's
 *     persisted `tool_pool_hash` no longer matches the currently-resolved
 *     registry. A mismatch here means the Runner's tool surface changed
 *     between the last bracket-persist and the resume — replaying against
 *     a drifted pool could invoke a different tool under the same name.
 */
export type ToolPoolStaleReason =
  | "idempotency-retention-insufficient"
  | "tool-pool-hash-mismatch";

/**
 * Raised by `new ToolRegistry(...)` / `loadToolRegistry(...)` when a tool entry
 * violates a §12.2 classification invariant. The Runner bin MUST exit non-zero
 * without opening any listener when this fires — per §12.2 the bad tool must
 * never become resolvable by the permission resolver.
 */
export class ToolPoolStale extends Error {
  readonly reason: ToolPoolStaleReason;
  readonly offendingTool: string;
  constructor(offendingTool: string, reason: ToolPoolStaleReason) {
    super(`ToolPoolStale reason=${reason} tool="${offendingTool}"`);
    this.name = "ToolPoolStale";
    this.reason = reason;
    this.offendingTool = offendingTool;
  }
}
