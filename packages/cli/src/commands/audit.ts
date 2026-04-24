/**
 * soa audit tail — polls /audit/tail and prints new rows as they arrive.
 *
 * Exits 0 on SIGINT. Uses a simple high-water-mark on record_count + last_hash
 * to detect new rows between polls.
 */
import { RunnerClient, type RunnerClientOptions, type AuditTailResponse } from "../client.js";

export interface AuditTailCommandOptions extends RunnerClientOptions {
  /** Poll interval in ms. Defaults to 3000. */
  pollIntervalMs?: number;
  /** When set, runs N polls then exits (for CI/tests). 0 = infinite. Defaults to 0. */
  maxPolls?: number;
  /** Max rows per poll. Defaults to 25. */
  limit?: number;
  /** Output format. "json" (one JSON per new row) or "pretty" (human). Defaults to "pretty". */
  format?: "json" | "pretty";
}

function prettyRow(row: NonNullable<AuditTailResponse["records"]>[0]): string {
  const parts = [row.timestamp, row.kind ?? "?"];
  if (row.stop_reason) {
    const tail = row.dispatcher_error_code
      ? `${row.stop_reason} [${row.dispatcher_error_code}]`
      : row.stop_reason;
    parts.push(tail);
  }
  return parts.join("  ");
}

export async function auditTailCommand(opts: AuditTailCommandOptions): Promise<number> {
  const client = new RunnerClient(opts);
  const interval = opts.pollIntervalMs ?? 3000;
  const limit = opts.limit ?? 25;
  const format = opts.format ?? "pretty";
  const maxPolls = opts.maxPolls ?? 0;

  let seenCount = 0;
  let polls = 0;
  let keepGoing = true;

  const onSigint = () => {
    keepGoing = false;
  };
  process.on("SIGINT", onSigint);

  try {
    while (keepGoing) {
      polls++;
      let tail: AuditTailResponse;
      try {
        tail = await client.getAuditTail(limit);
      } catch (err) {
        process.stderr.write(`audit-tail error: ${(err as Error).message}\n`);
        await new Promise((r) => setTimeout(r, interval));
        if (maxPolls > 0 && polls >= maxPolls) break;
        continue;
      }

      const rows = tail.records ?? [];
      const newRows = rows.slice(0, Math.max(0, rows.length - seenCount));
      for (const row of [...newRows].reverse()) {
        if (format === "json") {
          process.stdout.write(JSON.stringify(row) + "\n");
        } else {
          process.stdout.write(prettyRow(row) + "\n");
        }
      }
      seenCount = rows.length;

      if (maxPolls > 0 && polls >= maxPolls) break;
      await new Promise((r) => setTimeout(r, interval));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  return 0;
}
