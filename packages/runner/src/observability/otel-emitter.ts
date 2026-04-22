/**
 * §14.4 OTel emission bridge (Finding W / SV-STR-06/07).
 *
 * The Runner's decision call-site emits, per POST /permissions/decisions:
 *
 *   - `soa.turn` — outer envelope span wrapping the decision lifecycle.
 *   - `soa.tool.<tool_name>` — child span per tool invocation, with the
 *     permission outcome + risk class in its attributes.
 *
 * Both spans share a trace_id; the tool span's parent_span_id matches
 * the turn span's span_id. Both carry `resource_attributes` synthesized
 * from the Agent Card's `observability.requiredResourceAttrs`
 * (defaulted per §14.4 when unset).
 *
 * Every emitted StreamEvent whose lifecycle falls inside the decision
 * call (here: the PermissionDecision event) MUST appear as a span event
 * on the matching span, carrying the StreamEvent.event_id as an
 * attribute (so validators can correlate OTel output back to
 * /events/recent).
 *
 * The bridge writes into the shared OtelSpanStore that backs
 * /observability/otel-spans/recent — no duplicate transport path.
 */

import { randomBytes } from "node:crypto";
import type { OtelSpanStore, OtelSpanRecord, OtelSpanEventRecord } from "./otel-span-store.js";

export const DEFAULT_REQUIRED_RESOURCE_ATTRS = [
  "service.name",
  "soa.agent.name",
  "soa.agent.version",
  "soa.billing.tag"
] as const;

export interface OtelEmitterConfig {
  /** Shared ring buffer the /observability/otel-spans/recent endpoint reads. */
  store: OtelSpanStore;
  /** Agent Card agent_name (required span attribute). */
  agentName: string;
  /** Agent Card agent_version (required span attribute). */
  agentVersion: string;
  /** Agent Card billingTag (empty string until Finding Q lands). */
  billingTag: string;
  /**
   * Agent Card `observability.requiredResourceAttrs` — when unset the
   * §14.4 default set applies. Every listed name is emitted in
   * `resource_attributes` with a deterministic value; unknown names
   * fall back to `""` so the span still carries the key (validator
   * asserts presence, not value).
   */
  requiredResourceAttrs?: readonly string[];
  /** Runner version string ("service.version"). Default "1.0". */
  runnerVersion?: string;
  /** ISO clock for span timestamps. */
  clock: () => Date;
}

export interface EmitDecisionSpansParams {
  session_id: string;
  turn_id: string;
  tool_name: string;
  tool_risk_class: string;
  permission_decision: string;
  /** §14.1 PermissionDecision event_id this decision produced. */
  permission_decision_event_id?: string;
}

function randomHex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

export class OtelEmitter {
  private readonly cfg: OtelEmitterConfig;
  private readonly requiredAttrs: readonly string[];

  constructor(cfg: OtelEmitterConfig) {
    this.cfg = cfg;
    this.requiredAttrs =
      cfg.requiredResourceAttrs && cfg.requiredResourceAttrs.length > 0
        ? cfg.requiredResourceAttrs
        : DEFAULT_REQUIRED_RESOURCE_ATTRS;
  }

  private resourceAttributes(): Record<string, unknown> {
    // Start from §14.4 required attrs; stamp known values + "" for
    // names we can't synthesize (validator asserts presence, not value).
    const out: Record<string, unknown> = {};
    for (const name of this.requiredAttrs) {
      switch (name) {
        case "service.name":
          out[name] = this.cfg.agentName;
          break;
        case "service.version":
          out[name] = this.cfg.runnerVersion ?? "1.0";
          break;
        case "soa.agent.name":
          out[name] = this.cfg.agentName;
          break;
        case "soa.agent.version":
          out[name] = this.cfg.agentVersion;
          break;
        case "soa.billing.tag":
          out[name] = this.cfg.billingTag;
          break;
        default:
          out[name] = "";
      }
    }
    return out;
  }

  /**
   * Emit the turn + tool spans for one /permissions/decisions call.
   * Returns both span records so the caller can correlate their IDs
   * into an audit trail if desired.
   */
  emitDecisionSpans(params: EmitDecisionSpansParams): {
    turn: OtelSpanRecord;
    tool: OtelSpanRecord;
  } {
    const now = this.cfg.clock().toISOString();
    const traceId = randomHex(16); // 32 hex chars
    const turnSpanId = randomHex(8); // 16 hex chars
    const toolSpanId = randomHex(8);
    const resourceAttributes = this.resourceAttributes();

    const spanEvents: OtelSpanEventRecord[] = [];
    if (params.permission_decision_event_id) {
      spanEvents.push({
        name: "soa.stream.event",
        time: now,
        attributes: {
          "soa.stream.event_id": params.permission_decision_event_id,
          "soa.stream.event_type": "PermissionDecision"
        }
      });
    }

    const turn: OtelSpanRecord = {
      span_id: turnSpanId,
      trace_id: traceId,
      parent_span_id: null,
      name: "soa.turn",
      start_time: now,
      end_time: now,
      attributes: {
        "soa.session.id": params.session_id,
        "soa.turn.id": params.turn_id,
        "soa.billing.tag": this.cfg.billingTag,
        "soa.agent.name": this.cfg.agentName,
        "soa.agent.version": this.cfg.agentVersion
      },
      events: spanEvents,
      status_code: "OK",
      resource_attributes: resourceAttributes
    };

    const tool: OtelSpanRecord = {
      span_id: toolSpanId,
      trace_id: traceId,
      parent_span_id: turnSpanId,
      name: `soa.tool.${params.tool_name}`,
      start_time: now,
      end_time: now,
      attributes: {
        "soa.tool.risk_class": params.tool_risk_class,
        "soa.permission.decision": params.permission_decision
      },
      events: spanEvents,
      status_code: "OK",
      resource_attributes: resourceAttributes
    };

    this.cfg.store.append(params.session_id, turn);
    this.cfg.store.append(params.session_id, tool);
    return { turn, tool };
  }
}
