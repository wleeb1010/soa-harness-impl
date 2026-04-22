import { spawn, type ChildProcess } from "node:child_process";
import {
  POST_TOOL_USE_TIMEOUT_MS,
  PRE_TOOL_USE_TIMEOUT_MS,
  type HookDecision,
  type HookOutcome,
  type HookStdin,
  type HookStdout
} from "./types.js";

export interface RunHookOptions {
  /** Executable + argv (e.g. ["/usr/bin/python3", "hook.py"]). */
  command: readonly string[];
  /** JSON body written to the hook's stdin. */
  stdin: HookStdin;
  /** Override the per-kind default timeout. */
  timeoutMs?: number;
  /** Optional cwd for the child process. */
  cwd?: string;
  /** Optional environment; merged into process.env. */
  env?: Record<string, string | undefined>;
  /**
   * §15 reentrancy-guard binding (Finding N / SV-HOOK-08). When set,
   * `onSpawn(pid)` fires after a successful spawn and `onExit()` fires
   * on either `close` or `error` — exactly once per invocation. The
   * decisions-route uses these to register + deregister the child with
   * a HookReentrancyTracker so inbound /permissions/decisions requests
   * carrying the hook's PID are recognized as reentrancy and rejected.
   *
   * onSpawn() does NOT fire when `command` is empty / the spawn throws
   * synchronously. onExit() DOES fire for every resolved code path
   * (timeout, crash, normal exit) after a successful spawn, so the
   * tracker's end() call stays balanced with its begin().
   */
  onSpawn?: (pid: number) => void;
  onExit?: () => void;
}

const STDERR_SAMPLE_BYTES = 2048;

function decisionForPre(code: number | null): { decision: HookDecision; reason?: HookOutcome["reason"] } {
  // §15.3 PreToolUse column: 0 Allow, 1 Deny, 2 Deny, 3 Prompt, other → 1.
  if (code === 0) return { decision: "Allow" };
  if (code === 1 || code === 2) return { decision: "Deny" };
  if (code === 3) return { decision: "Prompt" };
  return { decision: "Deny", reason: "hook-nonzero-exit" };
}

function decisionForPost(code: number | null): { decision: HookDecision; reason?: HookOutcome["reason"] } {
  // §15.3 PostToolUse: 0 Acknowledge, 1 error/no-retry, 2 force retry, 3 reserved.
  // For M1 the Runner treats "Acknowledge" and "retry" both as Allow (no
  // permission impact); non-zero non-allowed codes surface as Deny + reason.
  if (code === 0 || code === 2) return { decision: "Allow" };
  if (code === 1) return { decision: "Deny" };
  return { decision: "Deny", reason: "hook-nonzero-exit" };
}

function parseStdout(raw: string): { body: HookStdout | null; invalid: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { body: null, invalid: false };
  // §15.3 MUST be a SINGLE LINE. If it spans multiple lines, reject.
  if (trimmed.includes("\n")) return { body: null, invalid: true };
  try {
    const parsed = JSON.parse(trimmed) as HookStdout;
    return { body: parsed, invalid: false };
  } catch {
    return { body: null, invalid: true };
  }
}

export async function runHook(opts: RunHookOptions): Promise<HookOutcome> {
  const kind = opts.stdin.hook;
  const defaultTimeout = kind === "PreToolUse" ? PRE_TOOL_USE_TIMEOUT_MS : POST_TOOL_USE_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? defaultTimeout;

  const [exe, ...args] = opts.command;
  if (!exe) {
    return {
      kind,
      decision: "Deny",
      exitCode: null,
      stdout: null,
      stderrSample: "",
      timedOut: false,
      crashed: true,
      reason: "hook-crashed"
    };
  }

  return await new Promise<HookOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      const spawnOpts: Parameters<typeof spawn>[2] = {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {})
      };
      child = spawn(exe, args, spawnOpts);
    } catch (err) {
      resolve({
        kind,
        decision: "Deny",
        exitCode: null,
        stdout: null,
        stderrSample: err instanceof Error ? err.message : String(err),
        timedOut: false,
        crashed: true,
        reason: "hook-crashed"
      });
      return;
    }

    // §15 reentrancy-guard bookkeeping — fire onSpawn once the child
    // has a PID; balance with onExit on every completion path below.
    let exitFired = false;
    const fireExit = (): void => {
      if (exitFired) return;
      exitFired = true;
      opts.onExit?.();
    };
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);

    let timedOut = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited between the timeout check and kill call
      }
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderrBuf.length < STDERR_SAMPLE_BYTES) {
        stderrBuf += chunk;
        if (stderrBuf.length > STDERR_SAMPLE_BYTES) stderrBuf = stderrBuf.slice(0, STDERR_SAMPLE_BYTES);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      fireExit();
      resolve({
        kind,
        decision: "Deny",
        exitCode: null,
        stdout: null,
        stderrSample: err.message,
        timedOut: false,
        crashed: true,
        reason: "hook-crashed"
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      fireExit();
      if (timedOut) {
        resolve({
          kind,
          decision: "Deny",
          exitCode: null,
          stdout: null,
          stderrSample: stderrBuf,
          timedOut: true,
          crashed: false,
          reason: "hook-timeout"
        });
        return;
      }

      const parsed = parseStdout(stdoutBuf);
      const baseReason: HookOutcome["reason"] | undefined = parsed.invalid ? "hook-stdout-invalid" : undefined;

      // Signal exit with no exit code (platform quirks) → treat as crash.
      if (code === null && signal !== null) {
        resolve({
          kind,
          decision: "Deny",
          exitCode: null,
          stdout: parsed.body,
          stderrSample: stderrBuf,
          timedOut: false,
          crashed: true,
          reason: "hook-crashed"
        });
        return;
      }

      const mapper = kind === "PreToolUse" ? decisionForPre : decisionForPost;
      const { decision, reason } = mapper(code);
      resolve({
        kind,
        decision,
        exitCode: code,
        stdout: parsed.body,
        stderrSample: stderrBuf,
        timedOut: false,
        crashed: false,
        ...(baseReason !== undefined ? { reason: baseReason } : reason !== undefined ? { reason } : {})
      });
    });

    // Write the §15.2 stdin JSON and close the pipe so the child can exit
    // without reading more input.
    try {
      child.stdin?.end(JSON.stringify(opts.stdin) + "\n", "utf8");
    } catch {
      // stdin closed under us — child will observe EOF; let its exit drive
      // the outcome.
    }
  });
}
