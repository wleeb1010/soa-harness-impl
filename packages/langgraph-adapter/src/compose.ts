/**
 * Composition factory — Phase 2 module C.
 *
 * Wires together the four Phase 1+2 building blocks into a single
 * adapter surface:
 *   - compliance-wrapper's permission-aware ToolNode (§18.5.2)
 *   - permission-hook's HTTP round-trip to /permissions/decisions (§10.3.2)
 *   - stream-event-synth's §14.6 direct mapping
 *   - audit-sink's retention-class-stamped append (§10.5.6 + §18.5.3 SV-ADAPTER-04)
 *
 * Deliberately does NOT start an HTTP server. The returned object is a
 * composed set of pieces; wiring to Fastify (buildRunnerApp from
 * @soa-harness/runner) is a follow-up. This factory is the unit-testable
 * assembly point validated by the SV-ADAPTER conformance probes in
 * test/conformance/.
 */

import { buildPermissionAwareToolNode } from "./compliance-wrapper.js";
import type { MessagesState } from "./compliance-wrapper.js";
import type { ToolNodeTool } from "./compliance-wrapper.js";
import { EventMapper } from "./stream-event-synth.js";
import {
  RunnerBackedPermissionHook,
  type RunnerBackedPermissionHookOptions,
} from "./permission-hook.js";
import {
  RunnerAuditSinkForwarder,
  type AuditSinkForwarderOptions,
} from "./audit-sink.js";
import { buildAdapterCard, type BuildAdapterCardOptions } from "./agent-card.js";
import type { PermissionHook } from "./types.js";
import type { RunnableConfig } from "@langchain/core/runnables";

export interface LangGraphAdapterOptions {
  /** Tools to expose through the permission-gated ToolNode. */
  tools: ToolNodeTool[];
  /** Permission-hook config (Runner base URL, bearer, session_id). */
  permission: RunnerBackedPermissionHookOptions;
  /** Audit-sink config (Runner base URL, bearer, activeMode). */
  audit: AuditSinkForwarderOptions;
  /** Agent Card config — baseCard + adapter_notes overlay. */
  card: BuildAdapterCardOptions;
}

export interface LangGraphAdapter {
  /** Permission-aware graph node. Use with `.addNode("tools", adapter.toolNode)`. */
  toolNode: (state: MessagesState, config?: RunnableConfig) => Promise<Partial<MessagesState>>;
  /** Per-session event mapper. Caller feeds LangGraph events through `map()`. */
  eventMapper: EventMapper;
  /** HTTP permission hook. Reused by toolNode internally; exposed for orchestrator bookkeeping. */
  permissionHook: PermissionHook;
  /** HTTP audit-sink forwarder. Orchestrator calls `.append(record)` per tool invocation. */
  auditSink: RunnerAuditSinkForwarder;
  /** Agent Card with adapter_notes.host_framework = "langgraph" populated. */
  agentCard: Record<string, unknown>;
}

/**
 * Assemble a LangGraph adapter from its four building blocks. One call
 * per session; the returned object is session-scoped (permission-hook
 * carries sessionId, audit-sink carries activeMode).
 */
export function createLangGraphAdapter(opts: LangGraphAdapterOptions): LangGraphAdapter {
  const permissionHook = new RunnerBackedPermissionHook(opts.permission);
  const auditSink = new RunnerAuditSinkForwarder(opts.audit);
  const eventMapper = new EventMapper();
  const toolNode = buildPermissionAwareToolNode({
    tools: opts.tools,
    hook: permissionHook,
  });
  const agentCard = buildAdapterCard(opts.card);

  return {
    toolNode,
    eventMapper,
    permissionHook,
    auditSink,
    agentCard,
  };
}
