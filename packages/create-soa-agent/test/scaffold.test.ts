import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { scaffold } from "../src/cli.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "create-soa-agent-"));
}

describe("create-soa-agent scaffold", () => {
  it("writes the expected template tree into the target", async () => {
    const root = tmpRoot();
    const target = join(root, "demo");
    try {
      const result = await scaffold({ projectName: "demo", targetDir: target, demo: true });
      expect(result.targetDir).toBe(target);
      for (const rel of [
        "agent-card.json",
        "initial-trust.json",
        "tools.json",
        "hooks/pre-tool-use.mjs",
        "AGENTS.md",
        "permission-decisions/auto-allow.json",
        "start.mjs",
        "package.json",
        "README.md"
      ]) {
        expect(existsSync(join(target, rel)), `missing ${rel}`).toBe(true);
      }
      // The .template file should be removed after substitution.
      expect(existsSync(join(target, "initial-trust.template.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agent-card.json validates against the pinned agent-card schema", async () => {
    const root = tmpRoot();
    const target = join(root, "demo");
    try {
      await scaffold({ projectName: "demo", targetDir: target, demo: true });
      const body = JSON.parse(readFileSync(join(target, "agent-card.json"), "utf8"));
      const valid = schemaRegistry["agent-card"];
      expect(valid(body), JSON.stringify(valid.errors ?? [])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("initial-trust.json validates against the pinned initial-trust schema", async () => {
    const root = tmpRoot();
    const target = join(root, "demo");
    try {
      await scaffold({ projectName: "demo", targetDir: target, demo: true });
      const body = JSON.parse(readFileSync(join(target, "initial-trust.json"), "utf8"));
      const valid = schemaRegistry["initial-trust"];
      expect(valid(body), JSON.stringify(valid.errors ?? [])).toBe(true);
      // The placeholder MUST be replaced by a real 64-hex SPKI.
      expect(body.spki_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(body.issued_at).not.toBe("__CLI_REPLACES_AT_INSTALL__");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("package.json has the requested project name", async () => {
    const root = tmpRoot();
    const target = join(root, "demo-alpha");
    try {
      await scaffold({ projectName: "demo-alpha", targetDir: target, demo: true });
      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
      expect(pkg.name).toBe("demo-alpha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing directory", async () => {
    const root = tmpRoot();
    const target = join(root, "demo");
    try {
      await scaffold({ projectName: "demo", targetDir: target, demo: true });
      await expect(
        scaffold({ projectName: "demo", targetDir: target, demo: true })
      ).rejects.toThrow(/already exists/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates a distinct SPKI on each scaffold run", async () => {
    const root = tmpRoot();
    try {
      const a = await scaffold({
        projectName: "demo-a",
        targetDir: join(root, "a"),
        demo: true
      });
      const b = await scaffold({
        projectName: "demo-b",
        targetDir: join(root, "b"),
        demo: true
      });
      expect(a.spkiSha256).not.toBe(b.spkiSha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
