import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAgentsMdDenyList,
  parseAgentsMdDenyList,
  assertAgentsMdListenerSafe,
  AgentsMdUnavailableStartup,
  AgentsMdOnPublicListener,
  loadToolRegistry
} from "../src/registry/index.js";

// SV-REG-04 — §11.2.1 AGENTS.md source-path test hook.
//
// The Runner loads AGENTS.md at startup, parses the
//   `## Agent Type Constraints` → `### Deny` section, and subtracts
// named tool names from the Tool Pool BEFORE /tools/registered ever
// surfaces the registry.
//
// Pinned fixture at
// ../soa-harness=specification/test-vectors/agents-md-denylist/ is the
// authoritative wire. This suite covers the parser + loader + integration
// with loadToolRegistry. Live end-to-end vs /tools/registered is covered
// by the bin smoke in STATUS.

const PINNED_AGENTS_MD = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "soa-harness=specification",
  "test-vectors",
  "agents-md-denylist",
  "AGENTS.md"
);
const PINNED_TOOLS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "soa-harness=specification",
  "test-vectors",
  "agents-md-denylist",
  "tools-with-denied.json"
);

describe("parseAgentsMdDenyList — §11.2.1 markdown parser", () => {
  it("parses the pinned fixture: returns {fs_write_dangerous}", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const body = readFileSync(PINNED_AGENTS_MD, "utf8");
    const denied = parseAgentsMdDenyList(body);
    expect(denied).toEqual(new Set(["fs_write_dangerous"]));
  });

  it("returns empty set when no `## Agent Type Constraints` section present", () => {
    const body = `# Title\n\n## Other Section\n### Deny\nfoo\n`;
    expect(parseAgentsMdDenyList(body)).toEqual(new Set());
  });

  it("returns empty set when section exists but no `### Deny` subheading", () => {
    const body = `## Agent Type Constraints\n### Allow\nfoo\n`;
    expect(parseAgentsMdDenyList(body)).toEqual(new Set());
  });

  it("handles multiple denied tool names, one per line", () => {
    const body = [
      "# A",
      "",
      "## Agent Type Constraints",
      "",
      "### Deny",
      "",
      "fs_write_dangerous",
      "shell_exec",
      "net__publish",
      "",
      "## Other Section"
    ].join("\n");
    expect(parseAgentsMdDenyList(body)).toEqual(
      new Set(["fs_write_dangerous", "shell_exec", "net__publish"])
    );
  });

  it("tolerates bullet-prefixed lines (`- name`, `* name`)", () => {
    const body = [
      "## Agent Type Constraints",
      "### Deny",
      "- fs_write_dangerous",
      "* shell_exec",
      "+ net__publish"
    ].join("\n");
    expect(parseAgentsMdDenyList(body)).toEqual(
      new Set(["fs_write_dangerous", "shell_exec", "net__publish"])
    );
  });

  it("stops reading at the next `##` heading (not just `###`)", () => {
    const body = [
      "## Agent Type Constraints",
      "### Deny",
      "fs_write_dangerous",
      "## Unrelated Section",
      "shell_exec" // NOT in Deny — different section
    ].join("\n");
    expect(parseAgentsMdDenyList(body)).toEqual(new Set(["fs_write_dangerous"]));
  });

  it("stops reading at the next `###` heading within the same section", () => {
    const body = [
      "## Agent Type Constraints",
      "### Deny",
      "fs_write_dangerous",
      "### Allow",
      "shell_exec" // in Allow, not Deny
    ].join("\n");
    expect(parseAgentsMdDenyList(body)).toEqual(new Set(["fs_write_dangerous"]));
  });

  it("ignores comment-style lines and HTML comments", () => {
    const body = [
      "## Agent Type Constraints",
      "### Deny",
      "# this is a comment",
      "<!-- another comment -->",
      "fs_write_dangerous"
    ].join("\n");
    expect(parseAgentsMdDenyList(body)).toEqual(new Set(["fs_write_dangerous"]));
  });

  it("handles CRLF line endings (Windows-authored AGENTS.md)", () => {
    const body =
      "## Agent Type Constraints\r\n### Deny\r\nfs_write_dangerous\r\nshell_exec\r\n";
    expect(parseAgentsMdDenyList(body)).toEqual(
      new Set(["fs_write_dangerous", "shell_exec"])
    );
  });
});

describe("loadAgentsMdDenyList — §11.2.1 fail-startup semantics", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soa-agentsmd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the pinned fixture without throwing", () => {
    const loaded = loadAgentsMdDenyList(PINNED_AGENTS_MD);
    expect(loaded.path).toBe(PINNED_AGENTS_MD);
    expect(loaded.denied.has("fs_write_dangerous")).toBe(true);
  });

  it("missing file: throws AgentsMdUnavailableStartup reason=file-missing", () => {
    expect(() => loadAgentsMdDenyList(join(dir, "does-not-exist.md"))).toThrow(
      AgentsMdUnavailableStartup
    );
    try {
      loadAgentsMdDenyList(join(dir, "does-not-exist.md"));
    } catch (err) {
      expect(err).toBeInstanceOf(AgentsMdUnavailableStartup);
      expect((err as AgentsMdUnavailableStartup).reason).toBe("file-missing");
    }
  });

  it("readable but empty-section file: loads with empty deny-set", () => {
    const p = join(dir, "AGENTS.md");
    writeFileSync(p, "# Minimal AGENTS.md with no constraints section\n", "utf8");
    const loaded = loadAgentsMdDenyList(p);
    expect(loaded.denied.size).toBe(0);
  });
});

describe("assertAgentsMdListenerSafe — §11.2.1 loopback guard", () => {
  it("no env path set: passes for any host (hook disabled)", () => {
    expect(() =>
      assertAgentsMdListenerSafe({ agentsMdPath: undefined, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("loopback hosts allowed when env set", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(() =>
        assertAgentsMdListenerSafe({ agentsMdPath: "/any/path", host })
      ).not.toThrow();
    }
  });

  it("non-loopback host + env set: throws AgentsMdOnPublicListener", () => {
    expect(() =>
      assertAgentsMdListenerSafe({ agentsMdPath: "/any/path", host: "0.0.0.0" })
    ).toThrow(AgentsMdOnPublicListener);
    expect(() =>
      assertAgentsMdListenerSafe({
        agentsMdPath: "/any/path",
        host: "192.168.1.5"
      })
    ).toThrow(AgentsMdOnPublicListener);
  });
});

describe("loadToolRegistry with AGENTS.md denylist (SV-REG-04 end-to-end)", () => {
  it("subtracts denied tools: pinned 5-tool fixture minus fs_write_dangerous = 4 tools", () => {
    const { denied } = loadAgentsMdDenyList(PINNED_AGENTS_MD);
    const registry = loadToolRegistry(PINNED_TOOLS, { denied });
    expect(registry.size()).toBe(4);
    expect(registry.lookup("fs_write_dangerous")).toBeUndefined();
    // Other tools survive.
    expect(registry.lookup("fs_read")).toBeDefined();
    expect(registry.lookup("fs_write_safe")).toBeDefined();
    expect(registry.lookup("http_get")).toBeDefined();
    expect(registry.lookup("shell_exec")).toBeDefined();
  });

  it("no denylist passed: full registry loads (backwards-compat)", () => {
    const registry = loadToolRegistry(PINNED_TOOLS);
    expect(registry.size()).toBe(5);
    expect(registry.lookup("fs_write_dangerous")).toBeDefined();
  });

  it("empty denylist: full registry loads (no-op subtraction)", () => {
    const registry = loadToolRegistry(PINNED_TOOLS, { denied: new Set() });
    expect(registry.size()).toBe(5);
  });

  it("denied name not in fixture: no-op", () => {
    const registry = loadToolRegistry(PINNED_TOOLS, { denied: new Set(["nonexistent_tool"]) });
    expect(registry.size()).toBe(5);
  });
});
