/**
 * §10.4.1 L-49 Finding BB — Autonomous→Interactive escalation state
 * machine + §10.4.2 test hooks.
 *
 * Triggered when:
 *   resolved_control = Prompt
 *   signer.role      = Autonomous
 *   tool.risk_class  ∈ {Mutating, Destructive}
 *
 * Flow per §10.4.1:
 *   1. Block decision.
 *   2. Emit PermissionPrompt with handler:Interactive.
 *   3. Await Interactive responder.
 *   4. Timeout → escalation-timeout (audit handler:Autonomous).
 *   5. Interactive approval → process with Interactive as audit handler.
 *   6. Interactive denial → hitl-denied (audit handler:Interactive).
 *
 * §10.4.2 test hook SOA_HANDLER_ESCALATION_RESPONDER watches a file
 * polled at `tickMs` (defaults to a short interval under the env). The
 * file carries `{kid, response ∈ {approve, deny, silence}}`. The kid
 * MUST be enrolled with role=Interactive — Autonomous/Coordinator
 * responders are rejected with hitl-required per SV-PERM-04 gate.
 * Truncate-after-ingest so a fresh write triggers the next cycle.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Clock } from "../clock/index.js";
import type { HandlerKeyRegistry, HandlerRole } from "./handler-key.js";

export type EscalationOutcomeKind =
  | "approved" // Interactive-signed approval
  | "denied" // Interactive denial
  | "timeout" // No response before timeout
  | "hitl-required"; // Responder kid bound to Autonomous/Coordinator role

export interface EscalationOutcome {
  kind: EscalationOutcomeKind;
  /** Interactive approver kid on `approved`/`denied`; responder kid on `hitl-required`. */
  kid?: string;
  /** For hitl-required — the insufficient-role detail (autonomous-insufficient / coordinator-insufficient). */
  detail?: "autonomous-insufficient" | "coordinator-insufficient";
  /** RFC 3339 moment of the outcome — approves/denies carry the file-response time; timeout carries clock(). */
  at: string;
}

export interface EscalationResponderFile {
  kid?: unknown;
  response?: unknown;
}

export interface EscalationCoordinatorOptions {
  registry: HandlerKeyRegistry;
  clock: Clock;
  /** Default escalation timeout in ms. Production 30_000; test can shrink via env. */
  timeoutMs: number;
  /** §10.4.2 responder file path. When undefined, every escalation ends in timeout. */
  responderFilePath?: string;
  /** How often to poll the responder file. Defaults to min(timeoutMs/10, 250). */
  tickMs?: number;
  /** Test seam — replaceable setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * In-process escalation coordinator. Concurrent escalations are
 * serialized through per-call polling loops — simple and correct for
 * the conformance workload where tests fire one at a time.
 */
export class EscalationCoordinator {
  private readonly registry: HandlerKeyRegistry;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly tickMs: number;
  private readonly responderFilePath: string | undefined;
  private readonly setTimeoutFn: NonNullable<EscalationCoordinatorOptions["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<EscalationCoordinatorOptions["clearTimeoutFn"]>;
  private readonly setIntervalFn: NonNullable<EscalationCoordinatorOptions["setIntervalFn"]>;
  private readonly clearIntervalFn: NonNullable<EscalationCoordinatorOptions["clearIntervalFn"]>;

  constructor(opts: EscalationCoordinatorOptions) {
    this.registry = opts.registry;
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs;
    this.responderFilePath = opts.responderFilePath;
    this.tickMs = opts.tickMs ?? Math.max(50, Math.min(Math.floor(opts.timeoutMs / 10), 250));
    this.setTimeoutFn = opts.setTimeoutFn ?? ((c, m) => setTimeout(c, m));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
    this.setIntervalFn = opts.setIntervalFn ?? ((c, m) => setInterval(c, m));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  }

  /**
   * Await the §10.4.1 responder. Resolves with an outcome by either
   * the responder file firing first OR the timeout hitting. Never
   * rejects — abnormal conditions surface as outcome kinds.
   */
  awaitResponder(): Promise<EscalationOutcome> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (out: EscalationOutcome) => {
        if (done) return;
        done = true;
        if (pollHandle !== null) this.clearIntervalFn(pollHandle);
        if (timeoutHandle !== null) this.clearTimeoutFn(timeoutHandle);
        resolve(out);
      };

      const timeoutHandle = this.setTimeoutFn(() => {
        finish({ kind: "timeout", at: this.clock().toISOString() });
      }, this.timeoutMs);
      const tHandle = timeoutHandle as unknown as { unref?: () => void };
      if (typeof tHandle.unref === "function") tHandle.unref();

      let pollHandle: ReturnType<typeof setInterval> | null = null;
      if (this.responderFilePath !== undefined) {
        const file = this.responderFilePath;
        const tick = () => {
          const outcome = this.tryReadResponder(file);
          if (outcome !== null) finish(outcome);
        };
        // Check immediately so a file that already exists doesn't wait
        // a full tick before being consumed.
        tick();
        if (!done) {
          pollHandle = this.setIntervalFn(tick, this.tickMs);
          const pHandle = pollHandle as unknown as { unref?: () => void };
          if (typeof pHandle.unref === "function") pHandle.unref();
        }
      }
    });
  }

  /**
   * Read + classify the responder file. Returns null when absent /
   * unparseable / response=silence. On success truncates the file per
   * §10.4.2 so a subsequent write triggers a fresh cycle.
   */
  private tryReadResponder(filePath: string): EscalationOutcome | null {
    if (!existsSync(filePath)) return null;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    if (content.trim().length === 0) return null;
    let parsed: EscalationResponderFile;
    try {
      parsed = JSON.parse(content) as EscalationResponderFile;
    } catch {
      return null;
    }
    const kid = typeof parsed.kid === "string" ? parsed.kid : null;
    const response = typeof parsed.response === "string" ? parsed.response : null;
    // Truncate regardless — either we consumed it or it's malformed, but
    // leaving it would spin the poller.
    try {
      writeFileSync(filePath, "", "utf8");
    } catch {
      /* best-effort */
    }
    if (response === "silence") return null;
    if (kid === null) return null;

    // §10.4.2 responder kid role check — SV-PERM-04 gate.
    const role: HandlerRole | undefined = this.registry.get(kid)?.role;
    if (role === "Autonomous") {
      return {
        kind: "hitl-required",
        kid,
        detail: "autonomous-insufficient",
        at: this.clock().toISOString()
      };
    }
    if (role === "Coordinator") {
      return {
        kind: "hitl-required",
        kid,
        detail: "coordinator-insufficient",
        at: this.clock().toISOString()
      };
    }
    // Unknown role treated as Interactive for backward compat — the
    // conformance default handler is not tagged but IS Interactive.
    if (response === "approve") {
      return { kind: "approved", kid, at: this.clock().toISOString() };
    }
    if (response === "deny") {
      return { kind: "denied", kid, at: this.clock().toISOString() };
    }
    return null;
  }
}
