/**
 * §11.2.1 AGENTS.md Source Path Test Hook.
 *
 * When SOA_RUNNER_AGENTS_MD_PATH=<path> is set, the Runner loads the
 * file at startup, parses the `## Agent Type Constraints` →
 * `### Deny` section, and subtracts each named tool from the Tool
 * Pool surfaced by /tools/registered + the resolver lookup. Subtraction
 * is permanent for the lifetime of the Runner process — re-adding a
 * denied name via §11.3.1 dynamic registration does NOT override the
 * AGENTS.md denylist (denylist wins by design: the file is the
 * operator's signed-off contract with the orchestrator).
 *
 * Production guard: identical pattern to §11.3.1 / §12.5.2 / §10.6.1 —
 * the env hook MUST NOT be reachable by untrusted principals, so Runners
 * refuse startup when the env var is set and the listener binds to a
 * non-loopback host. The file is read from disk (not from HTTP), so the
 * guard is a belt-and-suspenders check against accidentally running a
 * test-hook-laden build on a public listener.
 *
 * Fail-startup: `AgentsMdUnavailableStartup` throws when the path doesn't
 * resolve to a readable file. The bin surfaces this as a loud stderr
 * line + non-zero exit so operators see the misconfiguration immediately
 * (per the L-35 spec MUST: "Fail-startup with AgentsMdUnavailableStartup
 * on missing/unreadable").
 *
 * Parser scope: single-level nested heading extraction.
 *   1. Find a line that begins with exactly `## Agent Type Constraints`.
 *   2. Within that section (until the next `## ` at column 0), find a
 *      `### Deny` subheading.
 *   3. Each subsequent non-empty, non-comment, non-heading line up to
 *      the next `## ` or `### ` is one tool name. Leading/trailing
 *      whitespace is trimmed.
 * Headings with different casing (e.g. `## agent type constraints`)
 * do NOT match — AGENTS.md is a convention document and consumers are
 * expected to use the canonical headings verbatim.
 */

import { existsSync, readFileSync } from "node:fs";

export class AgentsMdUnavailableStartup extends Error {
  readonly path: string;
  readonly reason: "file-missing" | "file-unreadable" | "parse-error";
  constructor(path: string, reason: "file-missing" | "file-unreadable" | "parse-error", detail?: string) {
    super(
      `AgentsMdUnavailableStartup: ${reason} at "${path}"` +
        (detail !== undefined ? ` — ${detail}` : "")
    );
    this.name = "AgentsMdUnavailableStartup";
    this.path = path;
    this.reason = reason;
  }
}

export class AgentsMdOnPublicListener extends Error {
  constructor(host: string) {
    super(
      `AgentsMdOnPublicListener: SOA_RUNNER_AGENTS_MD_PATH is set and listener ` +
        `binds to non-loopback host "${host}". Per §11.2.1 the AGENTS.md source-path ` +
        `hook MUST NOT be reachable by untrusted principals.`
    );
    this.name = "AgentsMdOnPublicListener";
  }
}

export function assertAgentsMdListenerSafe(opts: {
  agentsMdPath: string | undefined;
  host: string;
}): void {
  if (!opts.agentsMdPath) return;
  const host = opts.host.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) throw new AgentsMdOnPublicListener(opts.host);
}

/**
 * Parse an AGENTS.md body. Returns the set of tool names named under
 * `## Agent Type Constraints` → `### Deny`. Empty set when the section
 * is absent or empty (malformed sections are tolerated; a non-existent
 * Deny section is operator-intended "no restrictions").
 */
export function parseAgentsMdDenyList(content: string): Set<string> {
  const lines = content.split(/\r?\n/);
  const denied = new Set<string>();

  // Locate the `## Agent Type Constraints` heading.
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Agent Type Constraints\s*$/.test(lines[i] ?? "")) {
      sectionStart = i;
      break;
    }
  }
  if (sectionStart === -1) return denied;

  // Walk to the next `## ` heading — that's the section boundary.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "") && !/^###\s+/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  // Inside the section, find a `### Deny` subheading.
  let denyStart = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/^###\s+Deny\s*$/.test(lines[i] ?? "")) {
      denyStart = i;
      break;
    }
  }
  if (denyStart === -1) return denied;

  // Read denied tool names until the next `###` or `##` heading.
  for (let i = denyStart + 1; i < sectionEnd; i++) {
    const raw = lines[i] ?? "";
    if (/^#{2,3}\s+/.test(raw)) break;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Allow `#` or `<!--` as a comment marker; tolerate bullet prefixes.
    if (trimmed.startsWith("#") || trimmed.startsWith("<!--")) continue;
    const name = trimmed.replace(/^[-*+]\s+/, "").trim();
    if (name.length > 0) denied.add(name);
  }
  return denied;
}

export interface LoadedAgentsMd {
  path: string;
  denied: Set<string>;
  /** Original file contents (raw UTF-8). Exposed for debugging / audit logs. */
  raw: string;
}

/**
 * Load + parse an AGENTS.md file. Throws AgentsMdUnavailableStartup on
 * any disk/read/parse failure. Returns the deny-list set ready to
 * filter a Tool Registry.
 */
export function loadAgentsMdDenyList(path: string): LoadedAgentsMd {
  if (!existsSync(path)) {
    throw new AgentsMdUnavailableStartup(path, "file-missing");
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new AgentsMdUnavailableStartup(
      path,
      "file-unreadable",
      err instanceof Error ? err.message : String(err)
    );
  }
  try {
    const denied = parseAgentsMdDenyList(raw);
    return { path, denied, raw };
  } catch (err) {
    throw new AgentsMdUnavailableStartup(
      path,
      "parse-error",
      err instanceof Error ? err.message : String(err)
    );
  }
}
