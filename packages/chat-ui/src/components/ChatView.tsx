/**
 * ChatView — minimal chat interface. A chronological message list plus an
 * input box that fires a §16.6 streaming dispatch on submit.
 *
 * Accessibility notes (WCAG 2.1 AA targets):
 *   - The message list is `role="log"` + `aria-live="polite"` so screen
 *     readers announce new messages without interrupting user input.
 *   - The input is `<textarea>` with a visible label; Enter submits,
 *     Shift+Enter inserts a newline.
 *   - The submit button has an accessible name + disabled state during
 *     streaming so assistive tech announces "loading".
 *   - Color contrast is the adopter's responsibility via CSS; the component
 *     exposes data-* attributes for themeable styling rather than hardcoding
 *     colors.
 */
import React, { useState, useMemo, useRef, useEffect } from "react";
import { useDispatchStream } from "../hooks/useDispatchStream.js";
import type { DispatchRequest } from "@soa-harness/runner";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Terminal stop_reason for assistant messages that completed streaming. */
  stop_reason?: string | null;
  dispatcher_error_code?: string | null;
}

export interface ChatViewProps {
  runnerUrl: string;
  sessionBearer: string;
  sessionId: string;
  model: string;
  billingTag: string;
  /** Optional initial messages (e.g., restored from /sessions/:id/state). */
  initialMessages?: ChatMessage[];
  /** Budget ceiling for each dispatch. Defaults to 10k tokens. */
  budgetCeilingTokens?: number;
  /** Override correlation_id + turn_id generation (useful in tests). */
  idGenerator?: () => { correlation_id: string; turn_id: string; idempotency_key: string };
}

function defaultIds(): { correlation_id: string; turn_id: string; idempotency_key: string } {
  const rand = (p: string) =>
    p + Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
  return {
    correlation_id: rand("cor_"),
    turn_id: rand("trn_"),
    idempotency_key: rand("idem_"),
  };
}

export function ChatView(props: ChatViewProps): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages ?? []);
  const [input, setInput] = useState("");
  const [pendingDispatch, setPendingDispatch] = useState<DispatchRequest | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const dispatchStreamState = useDispatchStream({
    runnerUrl: props.runnerUrl,
    sessionBearer: props.sessionBearer,
    request: pendingDispatch ?? (emptyRequest(props) as DispatchRequest),
    autoStart: false,
  });

  // When a dispatch completes (done/error), write the assistant message into
  // the message log and clear the pending dispatch so the input re-enables.
  useEffect(() => {
    if (pendingDispatch && (dispatchStreamState.status === "done" || dispatchStreamState.status === "error")) {
      const assistantMsg: ChatMessage = {
        id: pendingDispatch.turn_id,
        role: "assistant",
        text: dispatchStreamState.text,
        stop_reason: dispatchStreamState.stop_reason,
        dispatcher_error_code: dispatchStreamState.dispatcher_error_code,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setPendingDispatch(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchStreamState.status]);

  // Fire the stream when a new pendingDispatch is set
  useEffect(() => {
    if (pendingDispatch) {
      dispatchStreamState.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDispatch]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || pendingDispatch) return;
    const ids = (props.idGenerator ?? defaultIds)();
    const userMsg: ChatMessage = { id: ids.turn_id + "-user", role: "user", text: input };
    const allMessagesForContext = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.text,
    }));
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setPendingDispatch({
      session_id: props.sessionId,
      turn_id: ids.turn_id,
      model: props.model,
      messages: allMessagesForContext as DispatchRequest["messages"],
      budget_ceiling_tokens: props.budgetCeilingTokens ?? 10_000,
      billing_tag: props.billingTag,
      correlation_id: ids.correlation_id,
      idempotency_key: ids.idempotency_key,
      stream: true,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as React.FormEvent);
    }
  };

  const streaming = pendingDispatch !== null && dispatchStreamState.status === "streaming";
  const displayMessages = useMemo(() => {
    if (streaming && dispatchStreamState.text) {
      return [
        ...messages,
        { id: "in-flight", role: "assistant" as const, text: dispatchStreamState.text },
      ];
    }
    return messages;
  }, [messages, streaming, dispatchStreamState.text]);

  return (
    <div className="soa-chat-view" data-testid="chat-view">
      <ol
        ref={listRef}
        className="soa-chat-messages"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        data-testid="chat-messages"
      >
        {displayMessages.map((m) => (
          <li
            key={m.id}
            data-role={m.role}
            data-testid={`chat-message-${m.role}`}
            className={`soa-chat-message soa-chat-message--${m.role}`}
          >
            <span className="soa-chat-role" aria-label={`${m.role} said`}>{m.role}:</span>
            <span className="soa-chat-text">{m.text}</span>
            {m.stop_reason && m.stop_reason !== "NaturalStop" ? (
              <span className="soa-chat-stop-reason" data-testid="chat-stop-reason">
                [{m.stop_reason}
                {m.dispatcher_error_code ? ` — ${m.dispatcher_error_code}` : ""}]
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <form onSubmit={onSubmit} className="soa-chat-input-row">
        <label htmlFor="soa-chat-input" className="soa-chat-input-label">
          Message
        </label>
        <textarea
          id="soa-chat-input"
          className="soa-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming}
          aria-describedby="soa-chat-input-hint"
          rows={2}
          data-testid="chat-input"
        />
        <p id="soa-chat-input-hint" className="soa-chat-input-hint">
          Enter to send, Shift+Enter for newline.
        </p>
        <div className="soa-chat-input-buttons">
          <button type="submit" disabled={streaming || !input.trim()} data-testid="chat-send">
            {streaming ? "Streaming…" : "Send"}
          </button>
          {streaming ? (
            <button
              type="button"
              onClick={() => dispatchStreamState.cancel()}
              aria-label="Cancel current dispatch"
              data-testid="chat-cancel"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function emptyRequest(props: ChatViewProps): Partial<DispatchRequest> {
  // Placeholder used by the hook before a real dispatch is queued. The hook's
  // autoStart is false so this is never actually transmitted.
  return {
    session_id: props.sessionId,
    turn_id: "trn_" + "x".repeat(20),
    model: props.model,
    messages: [],
    budget_ceiling_tokens: 1,
    billing_tag: props.billingTag,
    correlation_id: "cor_" + "x".repeat(20),
    idempotency_key: "idem_" + "x".repeat(20),
    stream: true,
  };
}
