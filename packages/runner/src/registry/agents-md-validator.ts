/**
 * §7 AGENTS.md full-grammar validator (Finding AT / SV-AGENTS suite).
 *
 * Extends the existing §11.2.1 deny-list parser with:
 *   - §7.2 required H2 headings (exactly 7, in order, no duplicates)
 *   - §7.2 #4 Self-Improvement Policy `entrypoint:` line matching
 *     Card `self_improvement.entrypoint_file`
 *   - §7.3 `@import` semantics — depth ≤ 8, cycle detection, UTF-8
 *     textual inclusion, imported files MUST NOT redeclare H1
 *
 * Errors are thrown from the validator; callers (start-runner) catch
 * and emit a Config/AgentsMdInvalid-or-similar record under
 * BOOT_SESSION_ID so /logs/system/recent surfaces the refusal.
 *
 * The module is pure (imports pass through a `readFile` function
 * injected by the caller) so unit tests cover every cycle/depth/
 * structure edge without touching the filesystem.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";

export const REQUIRED_H2_SEQUENCE: readonly string[] = [
  "Project Rules",
  "Agent Persona",
  "Immutables",
  "Self-Improvement Policy",
  "Memory Policy",
  "Human-in-the-Loop Gates",
  "Agent Type Constraints"
];

export type AgentsMdInvalidReason =
  | "missing-h1"
  | "duplicate-h1-in-import"
  | "missing-h2"
  | "duplicate-h2"
  | "out-of-order-h2"
  | "entrypoint-missing"
  | "entrypoint-mismatch";

export class AgentsMdInvalid extends Error {
  readonly reason: AgentsMdInvalidReason;
  readonly data: Record<string, unknown>;
  constructor(reason: AgentsMdInvalidReason, message: string, data: Record<string, unknown> = {}) {
    super(`AgentsMdInvalid(${reason}): ${message}`);
    this.name = "AgentsMdInvalid";
    this.reason = reason;
    this.data = data;
  }
}

export class AgentsMdImportDepthExceeded extends Error {
  readonly path: string;
  readonly depth: number;
  constructor(path: string, depth: number) {
    super(
      `AgentsMdImportDepthExceeded: ${path} at depth ${depth} exceeds the §7.3 maximum of 8`
    );
    this.name = "AgentsMdImportDepthExceeded";
    this.path = path;
    this.depth = depth;
  }
}

export class AgentsMdImportCycle extends Error {
  readonly path: string;
  readonly cycle: readonly string[];
  constructor(path: string, cycle: readonly string[]) {
    super(
      `AgentsMdImportCycle: ${path} forms a cycle through [${cycle.join(" → ")}]`
    );
    this.name = "AgentsMdImportCycle";
    this.path = path;
    this.cycle = cycle;
  }
}

const MAX_IMPORT_DEPTH = 8;

export interface ReadFileFn {
  (path: string): string;
}

export function defaultReadFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`AGENTS.md import "${path}" does not exist`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Resolve `@import` directives recursively by substituting the
 * imported file's body in place of the directive line. Enforces §7.3
 * depth and cycle rules. Path resolution base is the directory of the
 * file containing the directive.
 */
export function resolveAgentsMdImports(
  entryPath: string,
  readFile: ReadFileFn = defaultReadFile
): string {
  function recurse(path: string, depth: number, stack: readonly string[]): string {
    if (depth > MAX_IMPORT_DEPTH) {
      throw new AgentsMdImportDepthExceeded(path, depth);
    }
    if (stack.includes(path)) {
      throw new AgentsMdImportCycle(path, [...stack, path]);
    }
    const body = readFile(path);
    const lines = body.split(/\r?\n/);
    const out: string[] = [];
    // §7.3 — imported (non-root) files MUST NOT redeclare H1.
    if (depth > 0) {
      for (const line of lines) {
        if (/^#\s+/.test(line)) {
          throw new AgentsMdInvalid(
            "duplicate-h1-in-import",
            `imported file "${path}" redeclares H1 (line "${line}")`,
            { path, depth }
          );
        }
      }
    }
    for (const line of lines) {
      const m = /^@import\s+(.+?)\s*$/.exec(line);
      if (m !== null) {
        const rel = m[1]!;
        const nested = pathResolve(dirname(path), rel);
        out.push(recurse(nested, depth + 1, [...stack, path]));
      } else {
        out.push(line);
      }
    }
    return out.join("\n");
  }
  return recurse(entryPath, 0, []);
}

export interface AgentsMdParseOptions {
  /**
   * Card's `self_improvement.entrypoint_file`. When present, the
   * Self-Improvement Policy block MUST have `entrypoint: <value>`
   * naming the same path.
   */
  cardEntrypointFile?: string;
}

export interface AgentsMdParseResult {
  entrypoint: string | undefined;
  h2Order: readonly string[];
}

/**
 * Validate the AGENTS.md body against §7.2 rules. Throws
 * AgentsMdInvalid with a specific reason on any violation.
 * Content is the already-import-resolved body.
 */
export function validateAgentsMdBody(
  content: string,
  opts: AgentsMdParseOptions = {}
): AgentsMdParseResult {
  const lines = content.split(/\r?\n/);

  // Must have exactly one H1 `# AGENTS` at the top level. §7.2 mentions
  // H1 but the validator is lenient about whitespace + position — any
  // `# AGENTS` line counts.
  let hasH1 = false;
  for (const line of lines) {
    if (/^#\s+AGENTS\s*$/.test(line)) {
      hasH1 = true;
      break;
    }
  }
  if (!hasH1) {
    throw new AgentsMdInvalid(
      "missing-h1",
      "AGENTS.md is missing the required H1 heading `# AGENTS`",
      {}
    );
  }

  // Walk H2 headings in order.
  const h2Order: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m !== null) h2Order.push(m[1]!);
  }

  // Filter to required set — additional H2s are informative per §7.2.
  const requiredSet = new Set(REQUIRED_H2_SEQUENCE);
  const seenH2s = h2Order.filter((h) => requiredSet.has(h));

  // Duplicates?
  const counts = new Map<string, number>();
  for (const h of seenH2s) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const [h, n] of counts) {
    if (n > 1) {
      throw new AgentsMdInvalid(
        "duplicate-h2",
        `required H2 heading "${h}" appears ${n} times — exactly once is required per §7.2`,
        { heading: h, count: n }
      );
    }
  }

  // Missing?
  for (const req of REQUIRED_H2_SEQUENCE) {
    if (!counts.has(req)) {
      throw new AgentsMdInvalid(
        "missing-h2",
        `required H2 heading "## ${req}" is missing per §7.2`,
        { heading: req, seen: seenH2s }
      );
    }
  }

  // Order — the 7 required headings must appear in the §7.2 sequence
  // even if informative H2s are interleaved.
  for (let i = 0; i < REQUIRED_H2_SEQUENCE.length; i++) {
    if (seenH2s[i] !== REQUIRED_H2_SEQUENCE[i]) {
      throw new AgentsMdInvalid(
        "out-of-order-h2",
        `required H2 at position ${i + 1} is "${seenH2s[i]}"; expected "${REQUIRED_H2_SEQUENCE[i]}" per §7.2`,
        { expected: [...REQUIRED_H2_SEQUENCE], actual: seenH2s }
      );
    }
  }

  // §7.2 #4 — locate `entrypoint: <path>` inside the
  // Self-Improvement Policy block. Line format is forgiving on
  // surrounding whitespace.
  let inSiBlock = false;
  let entrypoint: string | undefined;
  for (const line of lines) {
    const h2m = /^##\s+(.+?)\s*$/.exec(line);
    if (h2m !== null) {
      inSiBlock = h2m[1] === "Self-Improvement Policy";
      continue;
    }
    if (!inSiBlock) continue;
    const em = /^\s*entrypoint:\s*(\S+)\s*$/.exec(line);
    if (em !== null) {
      entrypoint = em[1];
      break;
    }
  }

  if (opts.cardEntrypointFile !== undefined) {
    if (entrypoint === undefined) {
      throw new AgentsMdInvalid(
        "entrypoint-missing",
        `AGENTS.md Self-Improvement Policy lacks the required "entrypoint:" line — Card declares entrypoint_file="${opts.cardEntrypointFile}"`,
        { expected: opts.cardEntrypointFile }
      );
    }
    if (entrypoint !== opts.cardEntrypointFile) {
      throw new AgentsMdInvalid(
        "entrypoint-mismatch",
        `AGENTS.md entrypoint="${entrypoint}" disagrees with Card entrypoint_file="${opts.cardEntrypointFile}"`,
        { agents_md: entrypoint, card: opts.cardEntrypointFile }
      );
    }
  }

  return { entrypoint, h2Order: seenH2s };
}
