/**
 * §14.5.2 OTel span ring buffer backing GET /observability/otel-spans/recent.
 *
 * The Runner collects OTel-shaped span records from the request pipeline
 * (§13 budget path, §10.3 decision path, §14.1 StreamEvent emission sites)
 * and exposes them via a polling endpoint whose body is byte-equivalent
 * to the OTLP JSON export content. In M3 there is no real OTel SDK
 * integration yet — the store is empty-default and accepts pushes from
 * future dispatcher / exporter wiring. The endpoint surface is stable
 * so validators can pin on the response shape independent of when the
 * producer side lands.
 *
 * Partitioning: per-session ring buffers. §14.5.2 is a session-scoped
 * read, so the buffer layout mirrors /events/recent.
 *
 * Retention: FIFO ring bounded by maxSpansPerSession (default 1000).
 * Same policy as the §14.1 StreamEventEmitter.
 *
 * NOT-A-SIDE-EFFECT: reads return defensive copies; neither snapshot()
 * nor the route handler mutate the store.
 */

export interface OtelSpanEventRecord {
  name: string;
  time: string;
  attributes?: Record<string, unknown>;
}

export interface OtelSpanRecord {
  span_id: string; // 16-hex
  trace_id: string; // 32-hex
  parent_span_id?: string | null;
  name: string;
  start_time: string;
  end_time: string;
  attributes: Record<string, unknown>;
  events?: OtelSpanEventRecord[];
  status_code: "OK" | "ERROR" | "UNSET";
  resource_attributes: Record<string, unknown>;
}

export interface OtelSpanStoreOptions {
  maxSpansPerSession?: number;
}

export class OtelSpanStore {
  private readonly spans = new Map<string, OtelSpanRecord[]>();
  private readonly maxPerSession: number;

  constructor(opts: OtelSpanStoreOptions = {}) {
    this.maxPerSession = opts.maxSpansPerSession ?? 1000;
  }

  /** Append a span record to the session's ring. FIFO-evict at capacity. */
  append(session_id: string, span: OtelSpanRecord): void {
    const arr = this.spans.get(session_id) ?? [];
    arr.push(span);
    if (arr.length > this.maxPerSession) arr.shift();
    this.spans.set(session_id, arr);
  }

  /** Defensive copy — callers cannot mutate the underlying buffer. */
  snapshot(session_id: string): readonly OtelSpanRecord[] {
    return (this.spans.get(session_id) ?? []).slice();
  }

  /** Total spans across all sessions (diagnostic). */
  countAll(): number {
    let n = 0;
    for (const arr of this.spans.values()) n += arr.length;
    return n;
  }

  /** Has this session seen any spans yet? */
  hasSession(session_id: string): boolean {
    return this.spans.has(session_id);
  }
}
