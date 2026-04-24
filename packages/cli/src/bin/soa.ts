#!/usr/bin/env node
/**
 * `soa` — SOA-Harness CLI entry point. Dispatches to one of the command
 * handlers based on argv[0].
 *
 * Subcommands:
 *   soa status   — one-shot health / readiness / version summary
 *   soa audit tail — poll /audit/tail and print new rows
 *   soa chat     — interactive streaming-dispatch REPL
 *   soa conform  — run soa-validate against the configured Runner
 */
import { statusCommand } from "../commands/status.js";
import { auditTailCommand } from "../commands/audit.js";
import { chatCommand } from "../commands/chat.js";
import { conformCommand } from "../commands/conform.js";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function resolveRunnerUrl(flags: Record<string, string | boolean>): string {
  const url = (flags["runner-url"] as string) ?? process.env.SOA_RUNNER_URL ?? "http://127.0.0.1:7700";
  return String(url).replace(/\/+$/, "");
}

function printHelp(): void {
  process.stdout.write(
    [
      "soa — SOA-Harness CLI",
      "",
      "Usage:",
      "  soa status [--runner-url URL] [--session-bearer TOKEN] [--quiet]",
      "  soa audit tail [--runner-url URL] --session-bearer TOKEN [--limit N] [--format json|pretty] [--poll-interval-ms N] [--max-polls N]",
      "  soa chat --session-bearer TOKEN --session-id ses_... [--runner-url URL] [--model NAME] [--billing-tag TAG] [--budget-ceiling-tokens N]",
      "  soa conform [--runner-url URL] [--profile core|core+si|core+handoff|full] [--spec-vectors PATH] [--out PATH] [--binary PATH]",
      "",
      "Environment:",
      "  SOA_RUNNER_URL       default --runner-url",
      "  SOA_SESSION_BEARER   default --session-bearer",
      "  SOA_ADMIN_BEARER     default --admin-bearer",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }
  const cmd = argv[0];
  const sub = argv[1];
  const rest = argv.slice(cmd === "audit" ? 2 : 1);
  const flags = parseFlags(rest);
  const runnerUrl = resolveRunnerUrl(flags);
  const sessionBearer =
    (flags["session-bearer"] as string) ?? process.env.SOA_SESSION_BEARER;
  const adminBearer =
    (flags["admin-bearer"] as string) ?? process.env.SOA_ADMIN_BEARER;

  switch (cmd) {
    case "status": {
      const statusOpts: Parameters<typeof statusCommand>[0] = { runnerUrl };
      if (sessionBearer) statusOpts.sessionBearer = sessionBearer;
      if (adminBearer) statusOpts.adminBearer = adminBearer;
      if (flags["quiet"] === true) statusOpts.quiet = true;
      return statusCommand(statusOpts);
    }
    case "audit": {
      if (sub !== "tail") {
        process.stderr.write(`soa audit: unknown subcommand '${sub}'. Try 'soa audit tail'.\n`);
        return 2;
      }
      const auditOpts: Parameters<typeof auditTailCommand>[0] = { runnerUrl };
      if (sessionBearer) auditOpts.sessionBearer = sessionBearer;
      if (adminBearer) auditOpts.adminBearer = adminBearer;
      if (flags["limit"]) auditOpts.limit = Number(flags["limit"]);
      if (flags["poll-interval-ms"]) auditOpts.pollIntervalMs = Number(flags["poll-interval-ms"]);
      if (flags["max-polls"]) auditOpts.maxPolls = Number(flags["max-polls"]);
      auditOpts.format = (flags["format"] as "json" | "pretty") ?? "pretty";
      return auditTailCommand(auditOpts);
    }
    case "chat": {
      const sessionId = flags["session-id"] as string;
      if (!sessionId) {
        process.stderr.write("soa chat: --session-id required\n");
        return 2;
      }
      if (!sessionBearer) {
        process.stderr.write("soa chat: --session-bearer required\n");
        return 2;
      }
      const chatOpts: Parameters<typeof chatCommand>[0] = {
        runnerUrl,
        sessionBearer,
        sessionId,
        model: (flags["model"] as string) ?? "example-adapter-model-id",
        billingTag: (flags["billing-tag"] as string) ?? "tenant-a/env-cli",
      };
      if (flags["budget-ceiling-tokens"]) {
        chatOpts.budgetCeilingTokens = Number(flags["budget-ceiling-tokens"]);
      }
      return chatCommand(chatOpts);
    }
    case "conform": {
      const conformOpts: Parameters<typeof conformCommand>[0] = { runnerUrl };
      conformOpts.profile = (flags["profile"] as "core" | "core+si" | "core+handoff" | "full") ?? "core";
      if (flags["spec-vectors"]) conformOpts.specVectors = flags["spec-vectors"] as string;
      if (flags["out"]) conformOpts.out = flags["out"] as string;
      if (flags["binary"]) conformOpts.binary = flags["binary"] as string;
      return conformCommand(conformOpts);
    }
    default:
      process.stderr.write(`soa: unknown command '${cmd}'. Run 'soa --help'.\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`soa: FATAL: ${(err as Error).message}\n`);
    process.exit(1);
  });
