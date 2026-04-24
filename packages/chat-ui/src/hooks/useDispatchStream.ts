/**
 * useDispatchStream — React hook that fires a §16.6 streaming dispatch against
 * a Runner and incrementally aggregates the emitted ContentBlockDelta text.
 *
 * Contract:
 *   - Caller supplies the runnerUrl, sessionBearer, and the DispatchRequest
 *     body. The hook sets Accept: text/event-stream and body.stream=true so
 *     the Runner routes to the SSE path per §16.6.2.
 *   - Returns the streaming state: status ("idle" | "streaming" | "done" |
 *     "error"), accumulated text, and a cancel() function that POSTs
 *     /dispatch/{correlation_id}/cancel per §16.6.4.
 *   - Uses the browser's fetch Response.body ReadableStream directly — no
 *     EventSource because EventSource forces GET and we need POST with a
 *     JSON body.
 *
 * This hook is deliberately zero-dep beyond React. Adopters who want richer
 * streaming state (delta-by-delta, event history, tool calls mid-stream) can
 * compose it with the @soa-harness/runner StreamedDispatchEvent types.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DispatchRequest,
  StreamedDispatchEvent,
  StopReason,
  DispatcherErrorCode,
} from "@soa-harness/runner";

export type DispatchStreamStatus = "idle" | "streaming" | "done" | "error";

export interface DispatchStreamState {
  status: DispatchStreamStatus;
  /** Accumulated text across all ContentBlockDelta events. */
  text: string;
  /** Every StreamEvent received, in wire order. */
  events: StreamedDispatchEvent[];
  /** Terminal stop_reason from MessageEnd (null until stream terminates). */
  stop_reason: StopReason | null;
  /** Non-null iff stop_reason === "DispatcherError". */
  dispatcher_error_code: DispatcherErrorCode | null;
  /** HTTP-level failure message (e.g., 406 DispatcherStreamUnsupported), else null. */
  http_error: string | null;
}

export interface UseDispatchStreamOptions {
  runnerUrl: string;
  sessionBearer: string;
  request: DispatchRequest;
  /** When true (default), auto-fire on mount. When false, call start() manually. */
  autoStart?: boolean;
}

const initial: DispatchStreamState = {
  status: "idle",
  text: "",
  events: [],
  stop_reason: null,
  dispatcher_error_code: null,
  http_error: null,
};

function parseSseFrame(frame: string): StreamedDispatchEvent | null {
  let type = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice("event: ".length);
    else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
  }
  if (!type || !dataLine) return null;
  try {
    return JSON.parse(dataLine) as StreamedDispatchEvent;
  } catch {
    return null;
  }
}

export function useDispatchStream(opts: UseDispatchStreamOptions): DispatchStreamState & {
  start: () => void;
  cancel: () => void;
} {
  const [state, setState] = useState<DispatchStreamState>(initial);
  const abortRef = useRef<AbortController | null>(null);
  const correlationIdRef = useRef<string>(opts.request.correlation_id);

  const start = useCallback(async () => {
    // Fresh abort controller per stream
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    correlationIdRef.current = opts.request.correlation_id;
    setState({ ...initial, status: "streaming" });

    try {
      const res = await fetch(`${opts.runnerUrl}/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${opts.sessionBearer}`,
        },
        body: JSON.stringify({ ...opts.request, stream: true }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        setState((s) => ({
          ...s,
          status: "error",
          http_error: `HTTP ${res.status}: ${body.slice(0, 400)}`,
        }));
        return;
      }

      if (!res.body) {
        setState((s) => ({ ...s, status: "error", http_error: "response.body missing" }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are delimited by blank lines (\n\n per §16.6.2)
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(":")) continue; // comment line (e.g., ": stream-done")
          const ev = parseSseFrame(frame);
          if (!ev) continue;

          setState((s) => {
            const next: DispatchStreamState = {
              ...s,
              events: [...s.events, ev],
            };
            if (ev.type === "ContentBlockDelta" && ev.delta?.text) {
              next.text = s.text + ev.delta.text;
            }
            if (ev.type === "MessageEnd") {
              next.status = "done";
              next.stop_reason = ev.stop_reason ?? null;
              next.dispatcher_error_code = ev.dispatcher_error_code ?? null;
            }
            return next;
          });
        }
      }

      // If we reach here without a MessageEnd having set status=done, treat
      // the stream as done-but-truncated.
      setState((s) => (s.status === "streaming" ? { ...s, status: "done" } : s));
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        setState((s) => ({ ...s, status: "done" }));
      } else {
        setState((s) => ({
          ...s,
          status: "error",
          http_error: (err as Error).message,
        }));
      }
    }
  }, [opts.runnerUrl, opts.sessionBearer, opts.request]);

  const cancel = useCallback(async () => {
    // Fire cancel endpoint + abort local fetch
    abortRef.current?.abort();
    try {
      await fetch(
        `${opts.runnerUrl}/dispatch/${correlationIdRef.current}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.sessionBearer}` },
        },
      );
    } catch {
      // Best-effort — if cancel fails, the local abort still stopped reads.
    }
  }, [opts.runnerUrl, opts.sessionBearer]);

  useEffect(() => {
    if (opts.autoStart !== false) {
      start();
    }
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...state, start, cancel };
}
