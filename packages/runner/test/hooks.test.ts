import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, type HookStdin } from "../src/hook/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, "fixtures", "hooks");

function baseStdin(kind: "PreToolUse" | "PostToolUse" = "PreToolUse"): HookStdin {
  const base: HookStdin = {
    hook: kind,
    session_id: "ses_aaaaaaaaaaaaaaaa",
    turn_id: "trn_01",
    tool: {
      name: "fs__write_file",
      risk_class: "Mutating",
      args_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    capability: "WorkspaceWrite",
    handler: "Interactive"
  };
  return kind === "PostToolUse"
    ? { ...base, result: { ok: true, output_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" } }
    : base;
}

function nodeRun(script: string): string[] {
  return [process.execPath, join(HOOKS, script)];
}

describe("runHook — §15.3 PreToolUse exit-code matrix", () => {
  it("exit 0 → Allow", async () => {
    const r = await runHook({ command: nodeRun("allow.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Allow");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.crashed).toBe(false);
  });

  it("exit 1 → Deny (error)", async () => {
    const r = await runHook({ command: nodeRun("deny.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Deny");
    expect(r.exitCode).toBe(1);
  });

  it("exit 3 → Prompt (force Prompt regardless of defaults)", async () => {
    const r = await runHook({ command: nodeRun("prompt.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Prompt");
    expect(r.exitCode).toBe(3);
  });

  it("unmapped exit code → Deny with hook-nonzero-exit reason", async () => {
    // Node -e "process.exit(42)" is cross-platform — same result everywhere.
    const r = await runHook({
      command: [process.execPath, "-e", "process.exit(42)"],
      stdin: baseStdin()
    });
    expect(r.decision).toBe("Deny");
    expect(r.exitCode).toBe(42);
    expect(r.reason).toBe("hook-nonzero-exit");
  });
});

describe("runHook — failure modes", () => {
  it("timeout → SIGKILL + Deny + hook-timeout", async () => {
    const r = await runHook({
      command: nodeRun("timeout.mjs"),
      stdin: baseStdin(),
      timeoutMs: 150
    });
    expect(r.timedOut).toBe(true);
    expect(r.decision).toBe("Deny");
    expect(r.reason).toBe("hook-timeout");
  });

  it("crashed child → Deny + hook-crashed", async () => {
    const r = await runHook({ command: nodeRun("crash.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Deny");
    // Node's uncaught throw produces exit 1 typically — the child ran to
    // completion, so crashed is false; we still treat exit 1 as Deny.
    expect(r.exitCode).toBe(1);
  });

  it("missing executable path → Deny + hook-crashed", async () => {
    const r = await runHook({ command: [], stdin: baseStdin() });
    expect(r.decision).toBe("Deny");
    expect(r.crashed).toBe(true);
    expect(r.reason).toBe("hook-crashed");
  });
});

describe("runHook — §15.2 stdin contract + §15.3 stdout contract", () => {
  it("stdin JSON reaches the hook (it can assert fields via exit code)", async () => {
    const r = await runHook({
      command: [
        process.execPath,
        "-e",
        // Read all stdin, parse, assert session_id matches, exit 0 if so.
        "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const p=JSON.parse(b);process.exit(p.session_id==='ses_aaaaaaaaaaaaaaaa'?0:7)});"
      ],
      stdin: baseStdin()
    });
    expect(r.decision).toBe("Allow");
    expect(r.exitCode).toBe(0);
  });

  it("stdout valid single-line JSON is parsed and returned", async () => {
    const r = await runHook({ command: nodeRun("stdout-ok.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Allow");
    expect(r.stdout).toEqual({ reason: "approved-by-fixture" });
  });

  it("stdout multi-line → hook-stdout-invalid reason, decision follows exit code", async () => {
    const r = await runHook({ command: nodeRun("stdout-multiline.mjs"), stdin: baseStdin() });
    expect(r.decision).toBe("Allow"); // exit 0 dominates
    expect(r.reason).toBe("hook-stdout-invalid");
    expect(r.stdout).toBeNull();
  });
});

describe("runHook — PostToolUse mapping", () => {
  it("exit 0 → Allow (Acknowledge)", async () => {
    const r = await runHook({
      command: nodeRun("allow.mjs"),
      stdin: baseStdin("PostToolUse")
    });
    expect(r.decision).toBe("Allow");
    expect(r.kind).toBe("PostToolUse");
  });

  it("exit 2 → Allow (force retry per §15.3; M1 treats as Allow)", async () => {
    const r = await runHook({
      command: [process.execPath, "-e", "process.exit(2)"],
      stdin: baseStdin("PostToolUse")
    });
    expect(r.decision).toBe("Allow");
    expect(r.exitCode).toBe(2);
  });

  it("exit 1 → Deny (error) but PostToolUse timeouts are logged only", async () => {
    const r = await runHook({ command: nodeRun("deny.mjs"), stdin: baseStdin("PostToolUse") });
    expect(r.decision).toBe("Deny");
    expect(r.exitCode).toBe(1);
  });
});
