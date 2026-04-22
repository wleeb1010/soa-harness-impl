import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateAgentsMdBody,
  resolveAgentsMdImports,
  AgentsMdInvalid,
  AgentsMdImportDepthExceeded,
  AgentsMdImportCycle,
  REQUIRED_H2_SEQUENCE,
  type ReadFileFn
} from "../src/registry/index.js";

// Finding AT — §7.2 H2 structure + §7.2 #4 entrypoint match + §7.3
// import depth/cycle semantics.

const CANONICAL_BODY = `# AGENTS

## Project Rules
Be helpful.

## Agent Persona
Neutral tone.

## Immutables
/tasks/ is read-only.

## Self-Improvement Policy
entrypoint: agent.py

## Memory Policy
Session scope by default.

## Human-in-the-Loop Gates
High-risk = prompt.

## Agent Type Constraints
### Deny
fs__write_file
`;

function scratch(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "agents-md-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Finding AT — validateAgentsMdBody", () => {
  it("canonical body passes", () => {
    const out = validateAgentsMdBody(CANONICAL_BODY);
    expect(out.entrypoint).toBe("agent.py");
    expect(out.h2Order).toEqual([...REQUIRED_H2_SEQUENCE]);
  });

  it("missing H1 → AgentsMdInvalid(missing-h1)", () => {
    const body = CANONICAL_BODY.replace(/^# AGENTS\s*\n/, "");
    try {
      validateAgentsMdBody(body);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      expect((err as AgentsMdInvalid).reason).toBe("missing-h1");
    }
  });

  it("missing required H2 → AgentsMdInvalid(missing-h2) with heading + seen", () => {
    const body = CANONICAL_BODY.replace(/^## Memory Policy\s*\nSession scope by default\.\s*\n\n/m, "");
    try {
      validateAgentsMdBody(body);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      const inv = err as AgentsMdInvalid;
      expect(inv.reason).toBe("missing-h2");
      expect(inv.data["heading"]).toBe("Memory Policy");
      expect((inv.data["seen"] as string[]).includes("Memory Policy")).toBe(false);
    }
  });

  it("duplicate H2 → AgentsMdInvalid(duplicate-h2)", () => {
    const body = CANONICAL_BODY + "\n## Memory Policy\nDuplicate block\n";
    try {
      validateAgentsMdBody(body);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      const inv = err as AgentsMdInvalid;
      expect(inv.reason).toBe("duplicate-h2");
      expect(inv.data["heading"]).toBe("Memory Policy");
      expect(inv.data["count"]).toBe(2);
    }
  });

  it("out-of-order H2 → AgentsMdInvalid(out-of-order-h2)", () => {
    // Swap Project Rules and Agent Persona.
    const body = CANONICAL_BODY
      .replace("## Project Rules\nBe helpful.", "## Agent Persona\nNeutral tone.")
      .replace("## Agent Persona\nNeutral tone.\n\n## Immutables", "## Project Rules\nBe helpful.\n\n## Immutables");
    try {
      validateAgentsMdBody(body);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      expect((err as AgentsMdInvalid).reason).toBe("out-of-order-h2");
    }
  });

  it("additional informative H2 between required ones is allowed", () => {
    const body = CANONICAL_BODY.replace(
      "## Immutables\n/tasks/ is read-only.",
      "## Immutables\n/tasks/ is read-only.\n\n## Project-Specific Guidance\nInformative block."
    );
    expect(() => validateAgentsMdBody(body)).not.toThrow();
  });

  it("entrypoint line missing when Card declares one → entrypoint-missing", () => {
    const body = CANONICAL_BODY.replace("entrypoint: agent.py\n", "");
    try {
      validateAgentsMdBody(body, { cardEntrypointFile: "agent.py" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      expect((err as AgentsMdInvalid).reason).toBe("entrypoint-missing");
    }
  });

  it("entrypoint disagrees with Card → entrypoint-mismatch", () => {
    try {
      validateAgentsMdBody(CANONICAL_BODY, { cardEntrypointFile: "other.py" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      const inv = err as AgentsMdInvalid;
      expect(inv.reason).toBe("entrypoint-mismatch");
      expect(inv.data["agents_md"]).toBe("agent.py");
      expect(inv.data["card"]).toBe("other.py");
    }
  });

  it("entrypoint matches Card → no throw", () => {
    expect(() =>
      validateAgentsMdBody(CANONICAL_BODY, { cardEntrypointFile: "agent.py" })
    ).not.toThrow();
  });

  it("no cardEntrypointFile supplied → entrypoint check skipped", () => {
    const body = CANONICAL_BODY.replace("entrypoint: agent.py\n", "");
    // Without a card to compare against, a missing entrypoint line is
    // not a §7.2 violation (validator-only pass).
    expect(() => validateAgentsMdBody(body)).not.toThrow();
  });
});

describe("Finding AT — resolveAgentsMdImports", () => {
  it("leaf file returns body verbatim", () => {
    const body = CANONICAL_BODY;
    const reader: ReadFileFn = (_p) => body;
    expect(resolveAgentsMdImports("/AGENTS.md", reader)).toBe(body);
  });

  it("single-level @import inlines the child body", () => {
    const rootPath = resolve("/root/AGENTS.md");
    const childPath = resolve("/root/deny-extras.md");
    const files: Record<string, string> = {
      [rootPath]: CANONICAL_BODY.replace(
        "### Deny\nfs__write_file",
        "### Deny\n@import ./deny-extras.md"
      ),
      [childPath]: "fs__write_file\nshell__run\n"
    };
    const reader: ReadFileFn = (p) => {
      if (p in files) return files[p]!;
      throw new Error(`not found: ${p}`);
    };
    const out = resolveAgentsMdImports(rootPath, reader);
    expect(out).toMatch(/fs__write_file/);
    expect(out).toMatch(/shell__run/);
  });

  it("depth-9 chain → AgentsMdImportDepthExceeded", () => {
    // Root imports file-1, file-1 imports file-2, ..., file-8 imports file-9.
    // Depth counter increments on recurse; depth 9 exceeds MAX 8.
    const reader: ReadFileFn = (p) => {
      const m = /file-(\d+)\.md$/.exec(p);
      if (m === null && p.endsWith("AGENTS.md")) {
        return `# AGENTS\n@import ./file-1.md\n`;
      }
      const n = Number.parseInt(m![1]!, 10);
      if (n < 9) return `@import ./file-${n + 1}.md\n`;
      return "tail content\n";
    };
    expect(() => resolveAgentsMdImports("/root/AGENTS.md", reader)).toThrowError(
      AgentsMdImportDepthExceeded
    );
  });

  it("A → B → A cycle → AgentsMdImportCycle", () => {
    const rootPath = resolve("/root/AGENTS.md");
    const bPath = resolve("/root/B.md");
    const files: Record<string, string> = {
      [rootPath]: "# AGENTS\n@import ./B.md\n",
      [bPath]: "@import ./AGENTS.md\n"
    };
    const reader: ReadFileFn = (p) => {
      if (p in files) return files[p]!;
      throw new Error(`not found: ${p}`);
    };
    try {
      resolveAgentsMdImports(rootPath, reader);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdImportCycle);
      const cyc = (err as AgentsMdImportCycle).cycle;
      expect(cyc[0]).toBe(rootPath);
      expect(cyc[cyc.length - 1]).toBe(rootPath);
    }
  });

  it("imported file redeclaring H1 → AgentsMdInvalid(duplicate-h1-in-import)", () => {
    const rootPath = resolve("/root/AGENTS.md");
    const childPath = resolve("/root/child.md");
    const files: Record<string, string> = {
      [rootPath]: "# AGENTS\n@import ./child.md\n",
      [childPath]: "# Child Heading\nbody\n"
    };
    const reader: ReadFileFn = (p) => {
      if (p in files) return files[p]!;
      throw new Error(`not found: ${p}`);
    };
    try {
      resolveAgentsMdImports(rootPath, reader);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdInvalid);
      expect((err as AgentsMdInvalid).reason).toBe("duplicate-h1-in-import");
    }
  });

  it("disk-path integration — on-disk depth-10 chain trips depth exceeded", () => {
    const s = scratch();
    try {
      writeFileSync(
        join(s.dir, "AGENTS.md"),
        "# AGENTS\n@import ./n1.md\n"
      );
      for (let i = 1; i <= 10; i++) {
        writeFileSync(
          join(s.dir, `n${i}.md`),
          i < 10 ? `@import ./n${i + 1}.md\n` : "tail\n"
        );
      }
      expect(() => resolveAgentsMdImports(join(s.dir, "AGENTS.md"))).toThrowError(
        AgentsMdImportDepthExceeded
      );
    } finally {
      s.dispose();
    }
  });

  it("validate-after-import surfaces import-resolved violations", () => {
    const s = scratch();
    try {
      // Root file is missing H2 — an imported file can't add it since
      // §7.2 violation is computed on the final resolved body.
      writeFileSync(
        join(s.dir, "AGENTS.md"),
        "# AGENTS\n@import ./child.md\n"
      );
      writeFileSync(
        join(s.dir, "child.md"),
        "## Project Rules\nBe helpful.\n"
      );
      const resolved = resolveAgentsMdImports(join(s.dir, "AGENTS.md"));
      try {
        validateAgentsMdBody(resolved);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentsMdInvalid);
        expect((err as AgentsMdInvalid).reason).toBe("missing-h2");
      }
    } finally {
      s.dispose();
    }
  });
});
