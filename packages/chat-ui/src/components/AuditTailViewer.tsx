/**
 * AuditTailViewer — read-only view of /audit/tail rows. Polls the endpoint on
 * an interval and renders the most recent N rows newest-first. Hash-chain
 * linkage is expressed via the row's prev_hash / this_hash; adopters SHOULD
 * verify the chain client-side for trust-minimized audit review.
 *
 * Accessibility: the list is `role="feed"` + each row is `role="article"` with
 * a heading hierarchy. The poll interval is announced to screen readers via
 * a visually-hidden aria-status region when new rows land.
 */
import React, { useEffect, useRef, useState } from "react";

export interface AuditTailRow {
  id?: string;
  timestamp: string;
  kind?: string;
  dispatch_id?: string;
  session_id?: string;
  stop_reason?: string;
  dispatcher_error_code?: string | null;
  billing_tag?: string;
  this_hash?: string;
  prev_hash?: string;
  [extra: string]: unknown;
}

export interface AuditTailViewerProps {
  runnerUrl: string;
  sessionBearer: string;
  /** Max rows to display. Defaults to 25. */
  limit?: number;
  /** Poll interval in ms. 0 disables polling; caller should mount/unmount to refresh. Defaults to 3000. */
  pollIntervalMs?: number;
}

export function AuditTailViewer(props: AuditTailViewerProps): React.ReactElement {
  const [rows, setRows] = useState<AuditTailRow[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const previousCountRef = useRef(0);

  useEffect(() => {
    const interval = props.pollIntervalMs ?? 3000;
    let cancelled = false;

    const fetchTail = async () => {
      try {
        setStatus("loading");
        const res = await fetch(
          `${props.runnerUrl}/audit/tail?limit=${props.limit ?? 25}`,
          {
            headers: { Authorization: `Bearer ${props.sessionBearer}` },
          },
        );
        if (cancelled) return;
        if (!res.ok) {
          const txt = await res.text();
          setStatus("error");
          setError(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
          return;
        }
        const body = (await res.json()) as { records?: AuditTailRow[] };
        setRows(body.records ?? []);
        setStatus("idle");
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError((err as Error).message);
      }
    };

    fetchTail();
    if (interval > 0) {
      const handle = globalThis.setInterval(fetchTail, interval);
      return () => {
        cancelled = true;
        globalThis.clearInterval(handle);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [props.runnerUrl, props.sessionBearer, props.limit, props.pollIntervalMs]);

  const newRowsAnnouncement =
    rows.length > previousCountRef.current
      ? `${rows.length - previousCountRef.current} new audit row${rows.length - previousCountRef.current === 1 ? "" : "s"}`
      : "";
  previousCountRef.current = rows.length;

  return (
    <section className="soa-audit-tail" aria-labelledby="soa-audit-tail-heading" data-testid="audit-tail-viewer">
      <h2 id="soa-audit-tail-heading">Audit tail</h2>
      <div role="status" aria-live="polite" className="soa-visually-hidden" data-testid="audit-announcement">
        {newRowsAnnouncement}
      </div>
      {status === "error" && error ? (
        <p className="soa-audit-error" role="alert" data-testid="audit-error">
          Error loading audit tail: {error}
        </p>
      ) : null}
      <ol className="soa-audit-rows" role="feed" aria-busy={status === "loading"} data-testid="audit-rows">
        {rows.length === 0 && status === "idle" ? (
          <li className="soa-audit-empty">No audit rows yet.</li>
        ) : null}
        {rows.map((r, idx) => (
          <li key={r.id ?? `${r.timestamp}-${idx}`} role="article" className="soa-audit-row" data-testid="audit-row">
            <header className="soa-audit-row-header">
              <time dateTime={r.timestamp}>{r.timestamp}</time>
              {r.kind ? <span className="soa-audit-kind">{r.kind}</span> : null}
            </header>
            {r.stop_reason ? (
              <p className="soa-audit-stop-reason">
                stop_reason: <strong>{r.stop_reason}</strong>
                {r.dispatcher_error_code ? ` — ${r.dispatcher_error_code}` : ""}
              </p>
            ) : null}
            {r.billing_tag ? <p className="soa-audit-billing">billing_tag: {r.billing_tag}</p> : null}
            {r.this_hash ? (
              <p className="soa-audit-hash">
                <span aria-label="this row's hash">hash:</span>{" "}
                <code>{r.this_hash.slice(0, 16)}…</code>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
