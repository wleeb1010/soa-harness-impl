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
}

export interface ToolsFile {
  $schema?: string;
  tools: ToolEntry[];
}
