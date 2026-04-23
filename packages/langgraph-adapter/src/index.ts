/**
 * @soa-harness/langgraph-adapter — SOA-Harness conformance adapter for
 * LangGraph.js. Phase 1 scaffold: compliance-wrapper only. Permission-hook
 * (HTTP), stream-event-synth (§14.6), and audit-sink land in Phase 2.
 */

export { buildPermissionAwareToolNode } from "./compliance-wrapper.js";
export type { MessagesState } from "./compliance-wrapper.js";
export type { PermissionDecision, PermissionHook } from "./types.js";
export { EventMapper } from "./stream-event-synth.js";
export type {
  SoaStreamEventType,
  DirectMappedType,
  LangGraphEvent,
  SoaStreamEventDraft,
} from "./stream-event-synth.js";
export {
  RunnerBackedPermissionHook,
  createRunnerBackedPermissionHook,
} from "./permission-hook.js";
export type {
  Observation,
  RunnerBackedPermissionHookOptions,
} from "./permission-hook.js";
export {
  RunnerAuditSinkForwarder,
  createRunnerAuditSinkForwarder,
  AuditSinkForwardError,
  deriveRetentionClass,
} from "./audit-sink.js";
export type {
  AuditSinkForwarderOptions,
  ToolInvocationAuditInput,
  AuditAppendResponse,
  RetentionClass,
} from "./audit-sink.js";

/** Adapter version shipped with this module — matches package.json. */
export const ADAPTER_VERSION = "1.0.0-rc.0";

/**
 * Closed `host_framework` enum value declared in the Agent Card's
 * `adapter_notes.host_framework` field per §18.5.1. Fixed for this
 * adapter; varies for other adapters (crewai, autogen, etc.).
 */
export const HOST_FRAMEWORK = "langgraph" as const;
