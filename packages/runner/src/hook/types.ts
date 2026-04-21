export type HookKind = "PreToolUse" | "PostToolUse";

/**
 * Stdin contract per Core §15.2. Sent as a single JSON line to the hook's
 * stdin; the hook is expected to either exit immediately or emit a single
 * line of stdout before exiting.
 */
export interface HookStdin {
  hook: HookKind;
  session_id: string;
  turn_id: string;
  tool: {
    name: string;
    risk_class: string;
    args?: unknown;
    args_digest: string;
  };
  capability: string;
  handler: string;
  /** PostToolUse only. */
  result?: {
    ok: boolean;
    output_digest: string;
  };
}

/**
 * Optional stdout body per §15.3. When non-empty stdout is a single-line JSON
 * object the Runner uses `reason` for audit-log text and (for PreToolUse)
 * `replace_args` to rewrite the tool's arguments or (for PostToolUse)
 * `replace_result` to rewrite the tool's response.
 */
export interface HookStdout {
  reason?: string;
  replace_args?: unknown;
  replace_result?: unknown;
}

export type HookDecision = "Allow" | "Deny" | "Prompt";

/**
 * Closed-enum post-run summary. `decision` drives the Runner's dispatch
 * (§15.4 step 2 for PreToolUse; PostToolUse's decision is advisory — exit
 * codes map to acknowledge / log-error / retry-once / reserved).
 */
export interface HookOutcome {
  kind: HookKind;
  decision: HookDecision;
  /** null if we couldn't determine a code (e.g. timeout before exit). */
  exitCode: number | null;
  stdout: HookStdout | null;
  /** First 2 KiB of stderr captured for audit. */
  stderrSample: string;
  /** True when the Runner SIGKILL'd the hook after the per-kind timeout. */
  timedOut: boolean;
  /** True when the child process failed to even spawn / dispatched an error. */
  crashed: boolean;
  /**
   * Closed failure-reason set for the audit log. Absent on clean Allow /
   * Acknowledge paths.
   *
   *   hook-timeout      — PreToolUse timed out past 5 s (Deny) or
   *                       PostToolUse timed out past 10 s (logged only)
   *   hook-crashed      — spawn / I/O error; couldn't run
   *   hook-nonzero-exit — exit code not in the §15.3 matrix; treated as 1
   *   hook-stdout-invalid — stdout non-empty and not single-line valid JSON
   */
  reason?: "hook-timeout" | "hook-crashed" | "hook-nonzero-exit" | "hook-stdout-invalid";
}

export const PRE_TOOL_USE_TIMEOUT_MS = 5_000;
export const POST_TOOL_USE_TIMEOUT_MS = 10_000;
