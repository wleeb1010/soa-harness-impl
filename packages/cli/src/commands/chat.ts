/**
 * soa chat — simple REPL chat against a Runner. Reads stdin lines, fires a
 * streaming dispatch per turn, prints ContentBlockDelta text chunks as they
 * arrive, prints the terminal stop_reason/usage summary on MessageEnd.
 *
 * Ctrl-C mid-stream fires POST /dispatch/{correlation_id}/cancel then exits.
 * Ctrl-D (stdin EOF) closes cleanly.
 *
 * Intentionally minimal — readline-based, no ink/blessed/third-party TUI.
 * Adopters who want a richer TUI compose RunnerClient.dispatchStream()
 * directly (same surface the chat-ui React package consumes).
 */
import { createInterface } from "node:readline/promises";
import { RunnerClient, type RunnerClientOptions } from "../client.js";
import type { DispatchRequest, DispatchMessage } from "@soa-harness/runner";

export interface ChatCommandOptions extends RunnerClientOptions {
  sessionId: string;
  model: string;
  billingTag: string;
  /** Default 10k per turn. */
  budgetCeilingTokens?: number;
  /** Optional hook invoked once per complete turn (tests use this). */
  onTurnComplete?: (summary: { text: string; stop_reason: string | null }) => void;
}

function randomId(prefix: string): string {
  return (
    prefix +
    Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20)
  );
}

export async function chatCommand(opts: ChatCommandOptions): Promise<number> {
  if (!opts.sessionBearer) {
    process.stderr.write("soa chat: --session-bearer is required\n");
    return 2;
  }
  const client = new RunnerClient(opts);
  const history: DispatchMessage[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(
    `soa chat — ${opts.runnerUrl} / session ${opts.sessionId} / model ${opts.model}\n` +
      "Enter text, Ctrl-C cancels mid-stream, Ctrl-D quits.\n\n",
  );

  let cancelInFlight: (() => void) | null = null;
  const onSigint = () => {
    if (cancelInFlight) {
      cancelInFlight();
    } else {
      rl.close();
    }
  };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      let prompt: string;
      try {
        prompt = await rl.question("> ");
      } catch {
        break; // readline closed (Ctrl-D)
      }
      if (!prompt.trim()) continue;

      history.push({ role: "user", content: prompt });

      const request: DispatchRequest = {
        session_id: opts.sessionId,
        turn_id: randomId("trn_"),
        model: opts.model,
        messages: history,
        budget_ceiling_tokens: opts.budgetCeilingTokens ?? 10_000,
        billing_tag: opts.billingTag,
        correlation_id: randomId("cor_"),
        idempotency_key: randomId("idem_"),
        stream: true,
      };

      let text = "";
      let stop_reason: string | null = null;
      let cancelled = false;
      cancelInFlight = () => {
        cancelled = true;
        client.cancelDispatch(request.correlation_id).catch(() => undefined);
      };

      try {
        for await (const event of client.dispatchStream(request)) {
          if (event.type === "ContentBlockDelta" && event.delta?.text) {
            process.stdout.write(event.delta.text);
            text += event.delta.text;
          }
          if (event.type === "MessageEnd") {
            stop_reason = event.stop_reason ?? null;
          }
        }
      } catch (err) {
        process.stderr.write(`\n[dispatch error: ${(err as Error).message}]\n`);
      } finally {
        cancelInFlight = null;
      }

      const tail = cancelled
        ? `[cancelled — ${stop_reason ?? "UserInterrupt"}]`
        : `[${stop_reason ?? "?"}]`;
      process.stdout.write(`\n${tail}\n\n`);

      if (text) {
        history.push({ role: "assistant", content: text });
      }
      opts.onTurnComplete?.({ text, stop_reason });
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
  return 0;
}
