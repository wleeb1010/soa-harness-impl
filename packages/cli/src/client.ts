/**
 * RunnerClient — thin HTTP wrapper around the Runner surface. Every command in
 * the CLI depends on this; the wrapper exists so commands stay concerned with
 * UX/formatting rather than fetch + bearer plumbing.
 *
 * Uses Node 20+ built-in fetch. No external HTTP dependency.
 */
import type { DispatchRequest, StreamedDispatchEvent } from "@soa-harness/runner";

export interface RunnerClientOptions {
  runnerUrl: string;
  /** Session bearer — required for session-scoped routes (audit, dispatch). */
  sessionBearer?: string;
  /** Admin/bootstrap bearer — required for /sessions POST + admin-scope reads. */
  adminBearer?: string;
  /** Per-request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

export interface HealthResponse {
  status: string;
  soaHarnessVersion?: string;
}

export interface ReadyResponse {
  status: string;
  reason?: unknown;
}

export interface VersionResponse {
  soaHarnessVersion?: string;
  supported_core_versions?: string[];
  runner_version?: string;
  spec_commit_sha?: string;
  generated_at?: string;
}

export interface AuditTailResponse {
  records?: Array<{
    id?: string;
    timestamp: string;
    kind?: string;
    stop_reason?: string;
    dispatcher_error_code?: string | null;
    [extra: string]: unknown;
  }>;
  record_count?: number;
  last_hash?: string;
}

export class RunnerClient {
  constructor(private readonly opts: RunnerClientOptions) {}

  private async req<T>(path: string, init: RequestInit = {}, bearer?: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(`${this.opts.runnerUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          ...(init.headers ?? {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } finally {
      clearTimeout(t);
    }
  }

  getHealth(): Promise<HealthResponse> {
    return this.req<HealthResponse>("/health");
  }

  getReady(): Promise<ReadyResponse> {
    return this.req<ReadyResponse>(
      "/ready",
      {},
      this.opts.sessionBearer ?? this.opts.adminBearer,
    );
  }

  getVersion(): Promise<VersionResponse> {
    return this.req<VersionResponse>(
      "/version",
      {},
      this.opts.sessionBearer ?? this.opts.adminBearer,
    );
  }

  async getAuditTail(limit: number = 25): Promise<AuditTailResponse> {
    const bearer = this.opts.sessionBearer ?? this.opts.adminBearer;
    if (!bearer) throw new Error("audit tail requires --session-bearer or --admin-bearer");
    return this.req<AuditTailResponse>(`/audit/tail?limit=${limit}`, {}, bearer);
  }

  /**
   * Fire a streaming dispatch. Returns an async iterable of parsed
   * StreamedDispatchEvent instances. Caller loops to consume.
   */
  async *dispatchStream(
    request: DispatchRequest,
  ): AsyncIterable<StreamedDispatchEvent> {
    if (!this.opts.sessionBearer) {
      throw new Error("dispatchStream requires --session-bearer");
    }
    const res = await fetch(`${this.opts.runnerUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.opts.sessionBearer}`,
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`POST /dispatch → ${res.status}: ${body.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("POST /dispatch: response body missing");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith(":")) continue;
        let type = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) type = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (!type || !data) continue;
        try {
          yield JSON.parse(data) as StreamedDispatchEvent;
        } catch {
          // skip malformed frame
        }
      }
    }
  }

  async cancelDispatch(correlationId: string): Promise<void> {
    if (!this.opts.sessionBearer) {
      throw new Error("cancelDispatch requires --session-bearer");
    }
    await this.req(
      `/dispatch/${correlationId}/cancel`,
      { method: "POST" },
      this.opts.sessionBearer,
    );
  }
}
