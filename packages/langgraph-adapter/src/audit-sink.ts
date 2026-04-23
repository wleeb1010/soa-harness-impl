/**
 * Audit-sink forwarder — Phase 2 module B.
 *
 * When LangGraph dispatches a tool inside the adapter's wrapped graph,
 * the back-end Runner never sees the invocation directly — LangGraph is
 * the dispatcher. Per §18.5.3 SV-ADAPTER-04 and §10.5 audit-chain
 * semantics, the adapter MUST forward a tool-invocation audit row to
 * the Runner so the chain remains authoritative over every
 * (permission, invocation, outcome) triple.
 *
 * This module is the HTTP client that does the forwarding.
 *
 * Out of scope (handled by the Runner): hash-chain linkage computation,
 * prev_hash resolution, JCS canonicalization of the record bytes,
 * concurrent-append ordering. The adapter provides a record payload
 * and a session-scoped bearer; the Runner writes the row into its own
 * hash-chained log and returns record_id + this_hash.
 *
 * retention_class derivation lives here because it's a pure function
 * of the session's granted activeMode (§10.5.6): DangerFullAccess →
 * dfa-365d, everything else → standard-90d. The adapter knows its
 * session's activeMode from the Agent Card it was configured with;
 * the Runner would apply the same rule on append but stamping
 * adapter-side removes one round-trip of schema validation.
 */

/**
 * §10.5.6 closed retention-class enum. `dfa-365d` = 365 days for
 * DangerFullAccess sessions; `standard-90d` = 90 days for all other
 * activeMode values.
 */
export type RetentionClass = "dfa-365d" | "standard-90d";

/**
 * Shape of a tool-invocation audit record the adapter forwards. All
 * fields here are adapter-observable — no Runner-side hash-chain
 * dependencies. The Runner fills in record_id, prev_hash, this_hash,
 * sink_timestamp per §10.5 on append.
 */
export interface ToolInvocationAuditInput {
  /** §12 session_id this tool call belongs to. */
  readonly session_id: string;
  /** LangGraph-derived tool_call_id (typically the run_id). */
  readonly tool_call_id: string;
  /** §11 Tool Registry tool name (e.g. `mcp__slack__send_message` or native equiv.). */
  readonly tool_name: string;
  /** SHA-256 over JCS-canonicalized args, hex-encoded per §14.1.1. */
  readonly args_digest: string;
  /** SHA-256 over JCS-canonicalized tool output, hex-encoded. */
  readonly output_digest?: string;
  /** True iff the tool returned without raising. */
  readonly ok: boolean;
  /** Error code if ok=false. §24 enum, otherwise free-form. */
  readonly error_code?: string;
  /** RFC 3339 timestamp when the adapter observed the tool returning. */
  readonly observed_at: string;
}

/**
 * Response body from a successful append. Record-identity fields come
 * from the Runner's chain writer.
 */
export interface AuditAppendResponse {
  readonly record_id: string;
  readonly this_hash: string;
  readonly prev_hash: string;
  readonly sink_timestamp: string;
  readonly retention_class: RetentionClass;
}

export interface AuditSinkForwarderOptions {
  /** Back-end Runner base URL, e.g. "http://localhost:7700". No trailing slash required. */
  runnerBaseUrl: string;
  /** Endpoint path; default "/audit/tool-invocations". Overridable for deployments that expose under a different route. */
  endpointPath?: string;
  /** Bearer token (or async provider) for the audit-append scope. */
  bearer: string | (() => Promise<string>);
  /** The session's granted activeMode — drives retention_class derivation. */
  activeMode: string;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * §10.5.6 retention-class derivation. Pure function of activeMode.
 * Exported so callers can stamp retention_class consistently in
 * related code paths (e.g. client-side dedupe keys).
 */
export function deriveRetentionClass(activeMode: string): RetentionClass {
  return activeMode === "DangerFullAccess" ? "dfa-365d" : "standard-90d";
}

export class AuditSinkForwardError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuditSinkForwardError";
  }
}

export class RunnerAuditSinkForwarder {
  private readonly runnerBaseUrl: string;
  private readonly endpointPath: string;
  private readonly bearer: string | (() => Promise<string>);
  private readonly activeMode: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AuditSinkForwarderOptions) {
    if (!opts.runnerBaseUrl) {
      throw new Error("RunnerAuditSinkForwarder: runnerBaseUrl is required");
    }
    if (!opts.activeMode) {
      throw new Error("RunnerAuditSinkForwarder: activeMode is required");
    }
    this.runnerBaseUrl = opts.runnerBaseUrl.replace(/\/+$/, "");
    this.endpointPath = opts.endpointPath ?? "/audit/tool-invocations";
    this.bearer = opts.bearer;
    this.activeMode = opts.activeMode;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Forward one tool-invocation record to the Runner. Returns the
   * Runner's response shape on success (record_id + hash-chain fields),
   * throws AuditSinkForwardError on failure.
   *
   * Unlike the permission hook, the audit-sink does NOT swallow errors
   * into a safe-default — audit is a write path, and a silent drop
   * would leave the tool execution unaccounted for in the chain. The
   * adapter orchestrator is responsible for buffering + retrying on
   * AuditSinkForwardError.
   */
  async append(record: ToolInvocationAuditInput): Promise<AuditAppendResponse> {
    let bearer: string;
    try {
      bearer = typeof this.bearer === "function" ? await this.bearer() : this.bearer;
    } catch (err) {
      throw new AuditSinkForwardError("bearer provider threw", err);
    }
    if (!bearer) {
      throw new AuditSinkForwardError("bearer is empty");
    }

    const retention_class = deriveRetentionClass(this.activeMode);
    const body = { ...record, retention_class };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(`${this.runnerBaseUrl}${this.endpointPath}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "authorization": `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        throw new AuditSinkForwardError(`audit append HTTP ${resp.status}`, undefined, resp.status);
      }

      let parsed: unknown;
      try {
        parsed = await resp.json();
      } catch (err) {
        throw new AuditSinkForwardError("malformed JSON in audit append response", err);
      }

      const shape = parsed as Partial<AuditAppendResponse>;
      if (
        typeof shape.record_id !== "string" ||
        typeof shape.this_hash !== "string" ||
        typeof shape.prev_hash !== "string" ||
        typeof shape.sink_timestamp !== "string" ||
        typeof shape.retention_class !== "string"
      ) {
        throw new AuditSinkForwardError("audit append response missing required fields");
      }
      return shape as AuditAppendResponse;
    } catch (err) {
      if (err instanceof AuditSinkForwardError) throw err;
      throw new AuditSinkForwardError("audit append failed", err);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** Factory with the same ergonomics as the permission-hook companion. */
export function createRunnerAuditSinkForwarder(
  opts: AuditSinkForwarderOptions,
): RunnerAuditSinkForwarder {
  return new RunnerAuditSinkForwarder(opts);
}
