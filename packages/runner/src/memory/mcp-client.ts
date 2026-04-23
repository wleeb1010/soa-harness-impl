/**
 * §8.1 / §8.3 Memory MCP HTTP client.
 *
 * Minimum-viable client for conformance — talks to the memory-mcp-mock
 * over HTTP. Real MCP JSON-RPC transport lands with M4 when the full
 * MCP shape arrives; for M3 the mock is HTTP-only and this client
 * matches.
 *
 * Default timeout: 2000 ms per §8.3 line 580.
 *
 * Timeout = a MemoryTimeout exception surfaces to the caller. The caller
 * (sessions-route, decision path, future turn loop) decides the response:
 * per §8.3, mid-loop timeout emits MemoryDegraded on the system event
 * log, and ≥ 3 consecutive loops terminate the session with
 * StopReason::MemoryDegraded (§8.3.1 → SessionEnd.payload.stop_reason).
 */

import type { SharingPolicy, DataClass } from "./state-store.js";

export class MemoryTimeout extends Error {
  readonly tool: string;
  constructor(tool: string, timeoutMs: number) {
    super(`MemoryTimeout tool="${tool}" timeout_ms=${timeoutMs}`);
    this.name = "MemoryTimeout";
    this.tool = tool;
  }
}

export class MemoryToolError extends Error {
  readonly tool: string;
  readonly detail: unknown;
  constructor(tool: string, detail: unknown) {
    super(`MemoryToolError tool="${tool}"`);
    this.name = "MemoryToolError";
    this.tool = tool;
    this.detail = detail;
  }
}

export interface MemoryMcpClientOptions {
  /** Base URL of the Memory MCP server (from memory.mcp_endpoint on the Agent Card). */
  endpoint: string;
  /** Per-call timeout in milliseconds. §8.3 default 2000 ms. */
  timeoutMs?: number;
}

export interface SearchMemoriesQuery {
  query: string;
  limit?: number;
  sharing_scope?: SharingPolicy;
}

export interface SearchedNote {
  note_id: string;
  summary: string;
  data_class: DataClass;
  composite_score: number;
  weight_semantic?: number;
  weight_recency?: number;
  weight_graph_strength?: number;
}

export interface AddMemoryNoteParams {
  summary: string;
  data_class: DataClass;
  session_id: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  toolName: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok && res.status !== 200) {
      // Mock 504 timeout counts as MemoryTimeout per the fixture contract.
      if (res.status === 504) throw new MemoryTimeout(toolName, timeoutMs);
      throw new MemoryToolError(toolName, { http_status: res.status });
    }
    const json = (await res.json()) as unknown;
    if (json && typeof json === "object" && "error" in (json as Record<string, unknown>)) {
      throw new MemoryToolError(toolName, json);
    }
    return json;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof MemoryTimeout || err instanceof MemoryToolError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new MemoryTimeout(toolName, timeoutMs);
    }
    // Connection refused / network error → also classify as MemoryTimeout
    // for the §8.3 "timeout or connection failure" branch.
    throw new MemoryTimeout(toolName, timeoutMs);
  }
}

export class MemoryMcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(opts: MemoryMcpClientOptions) {
    // Trim trailing slash so "<endpoint>/search_memories" composes cleanly.
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async searchMemories(query: SearchMemoriesQuery): Promise<{ notes: SearchedNote[] }> {
    const res = await postJson(
      `${this.endpoint}/search_memories`,
      query,
      this.timeoutMs,
      "search_memories"
    );
    if (!res || typeof res !== "object" || !Array.isArray((res as { notes?: unknown }).notes)) {
      throw new MemoryToolError("search_memories", { detail: "missing notes array in response" });
    }
    return res as { notes: SearchedNote[] };
  }

  async addMemoryNote(params: AddMemoryNoteParams): Promise<{ note_id: string }> {
    const res = await postJson(
      `${this.endpoint}/add_memory_note`,
      params,
      this.timeoutMs,
      "add_memory_note"
    );
    return res as { note_id: string };
  }

  async consolidateMemories(threshold?: string): Promise<{
    consolidated_count: number;
    pending_count: number;
  }> {
    const body: { consolidation_threshold?: string } = {};
    if (threshold !== undefined) body.consolidation_threshold = threshold;
    const res = await postJson(
      `${this.endpoint}/consolidate_memories`,
      body,
      this.timeoutMs,
      "consolidate_memories"
    );
    return res as { consolidated_count: number; pending_count: number };
  }
}

/**
 * §8.3 per-runner consecutive-failure tracker. Increment on each memory
 * call failure; reset on each success. When the counter crosses 3, any
 * memory-requiring session MUST terminate with MemoryDegraded.
 *
 * Scope: shared across all sessions in the Runner. Single HR-17 test
 * choreography hits this exactly.
 */
export class MemoryDegradationTracker {
  private consecutiveFailures = 0;
  /** §8.3 threshold — 3 consecutive failures. */
  readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  currentCount(): number {
    return this.consecutiveFailures;
  }

  /** True when the runner-wide threshold has been crossed. */
  isDegraded(): boolean {
    return this.consecutiveFailures >= this.threshold;
  }
}
