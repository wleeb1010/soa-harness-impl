/**
 * soa conform — thin wrapper around the soa-validate Go binary. The wrapper
 * exists so operators don't need to remember the exact --impl-url / --profile
 * / --spec-vectors arg shape; they type `soa conform` and get a sensible
 * default invocation against the configured Runner.
 *
 * If soa-validate isn't on PATH, we emit a helpful install command and exit 2.
 */
import { spawn } from "node:child_process";

export interface ConformCommandOptions {
  runnerUrl: string;
  /** Override soa-validate binary path. Defaults to `soa-validate` (PATH lookup). */
  binary?: string;
  /** Profile per §18.2. Defaults to "core". */
  profile?: "core" | "core+si" | "core+handoff" | "full";
  /** Path to the pinned spec repo. Defaults to "../soa-harness=specification" (conventional sibling layout). */
  specVectors?: string;
  /** Output path for release-gate.json. Defaults to "release-gate.json". */
  out?: string;
  /** Extra arguments appended verbatim to the soa-validate invocation. */
  extraArgs?: string[];
}

export async function conformCommand(opts: ConformCommandOptions): Promise<number> {
  const bin = opts.binary ?? "soa-validate";
  const args = [
    "--profile",
    opts.profile ?? "core",
    "--impl-url",
    opts.runnerUrl,
    "--spec-vectors",
    opts.specVectors ?? "../soa-harness=specification",
    "--out",
    opts.out ?? "release-gate.json",
    ...(opts.extraArgs ?? []),
  ];

  return await new Promise<number>((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        process.stderr.write(
          `soa conform: '${bin}' not found on PATH. Install with:\n` +
            `  go install github.com/wleeb1010/soa-validate/cmd/soa-validate@latest\n` +
            `Or pass --binary </path/to/soa-validate>.\n`,
        );
        resolve(2);
      } else {
        process.stderr.write(`soa conform: ${err.message}\n`);
        resolve(1);
      }
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
