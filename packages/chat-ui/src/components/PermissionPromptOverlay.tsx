/**
 * PermissionPromptOverlay — modal overlay rendered when the Runner requests a
 * permission decision (§10.3 / §14.1 PermissionPrompt StreamEvent).
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true" to trap the screen reader focus
 *   - Focus moves to the overlay's first actionable element on open
 *   - Escape triggers "deny" (consistent with §10.3 tighten-only default)
 *   - Allow / Deny buttons have explicit aria-labels describing the tool call
 *
 * The actual POST /permissions/decisions round-trip is the caller's
 * responsibility — the overlay just surfaces the UI + returns the chosen
 * outcome via onResolve. Adopters wire that into their dispatch pipeline.
 */
import React, { useEffect, useRef } from "react";

export interface PermissionPromptPayload {
  prompt_id: string;
  session_id: string;
  tool_name: string;
  tool_call_id?: string;
  reason?: string;
  /** Arbitrary per-tool args to show the user. */
  args?: Record<string, unknown>;
}

export interface PermissionPromptOverlayProps {
  prompt: PermissionPromptPayload | null;
  onResolve: (outcome: "allow" | "deny", reason?: string) => void;
}

export function PermissionPromptOverlay(props: PermissionPromptOverlayProps): React.ReactElement | null {
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (props.prompt) {
      allowRef.current?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onResolve("deny", "escape-key");
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    return undefined;
  }, [props.prompt, props]);

  if (!props.prompt) return null;

  const { prompt } = props;
  const headingId = `soa-prompt-heading-${prompt.prompt_id}`;
  const descId = `soa-prompt-desc-${prompt.prompt_id}`;

  return (
    <div
      className="soa-prompt-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descId}
      data-testid="permission-prompt-overlay"
    >
      <div className="soa-prompt-box">
        <h2 id={headingId}>Permission required</h2>
        <p id={descId}>
          Tool <strong>{prompt.tool_name}</strong> wants to execute.
          {prompt.reason ? ` Reason: ${prompt.reason}` : ""}
        </p>
        {prompt.args && Object.keys(prompt.args).length > 0 ? (
          <details className="soa-prompt-args" data-testid="permission-prompt-args">
            <summary>Tool arguments</summary>
            <pre>{JSON.stringify(prompt.args, null, 2)}</pre>
          </details>
        ) : null}
        <div className="soa-prompt-actions" role="group" aria-label="Permission decision">
          <button
            ref={allowRef}
            type="button"
            onClick={() => props.onResolve("allow")}
            aria-label={`Allow ${prompt.tool_name}`}
            data-testid="permission-allow"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => props.onResolve("deny", "user-denied")}
            aria-label={`Deny ${prompt.tool_name}`}
            data-testid="permission-deny"
          >
            Deny
          </button>
        </div>
        <p className="soa-prompt-hint">Press Escape to deny.</p>
      </div>
    </div>
  );
}
