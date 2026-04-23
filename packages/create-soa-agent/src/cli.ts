#!/usr/bin/env node
import "reflect-metadata";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, realpathSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate, X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

type CryptoKeyPair = webcrypto.CryptoKeyPair;

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, "..", "templates");

export type MemoryBackendChoice = "sqlite" | "mem0" | "zep" | "none";
const TEMPLATE_DIR_BY_MEMORY: Record<MemoryBackendChoice, string> = {
  sqlite: "runner-starter",
  mem0: "runner-starter-mem0",
  zep: "runner-starter-zep",
  none: "runner-starter-none"
};
const DEFAULT_MEMORY_BACKEND: MemoryBackendChoice = "sqlite";

/** Legacy single-template export retained for tests; always resolves to
 *  the sqlite-default `runner-starter/` directory. */
const TEMPLATE_ROOT = join(TEMPLATES_DIR, TEMPLATE_DIR_BY_MEMORY[DEFAULT_MEMORY_BACKEND]);

function resolveTemplateRoot(memory: MemoryBackendChoice): string {
  const dir = TEMPLATE_DIR_BY_MEMORY[memory];
  if (!dir) throw new Error(`create-soa-agent: unknown --memory=${memory}`);
  return join(TEMPLATES_DIR, dir);
}

const PLACEHOLDER_SPKI = "__CLI_REPLACES_AT_INSTALL_________________________________________";
const PLACEHOLDER_ISSUED = "__CLI_REPLACES_AT_INSTALL__";
const PLACEHOLDER_NAME = "__CLI_REPLACES_AT_INSTALL__";

interface ScaffoldOptions {
  projectName: string;
  targetDir: string;
  demo: boolean;
  /**
   * When true, the scaffolded demo is placed under the monorepo's
   * `examples/` workspace glob so the existing `workspace:*` deps
   * resolve via pnpm workspace linkage. Intended for in-monorepo dev
   * use only; outside a monorepo the scaffold call MUST throw.
   *
   * Added by Phase 0e E2(a) to clear Blocker #2 of the onboarding
   * dry-run (npm install fails on `workspace:*` outside pnpm). The
   * versioned-default path (E2(b)) ships after E3 npm publish.
   */
  link?: boolean;
  /**
   * Which Memory MCP backend the scaffolded demo should use. Default
   * `sqlite` (Phase 5, L-58): the scaffold ships @soa-harness/memory-mcp-sqlite
   * as a dependency and boots it in-process on :8001 at demo startup.
   * Other values select template variants (mem0 + zep bring their own
   * docker-compose; `none` preserves the M4 no-memory baseline).
   */
  memory?: MemoryBackendChoice;
  now?: Date;
}

export interface ScaffoldResult {
  targetDir: string;
  filesWritten: string[];
  publisherKid: string;
  spkiSha256: string;
  /** True iff scaffold was placed under the monorepo's examples/ glob. */
  linked: boolean;
  /** Which Memory MCP backend template was materialized. */
  memory: MemoryBackendChoice;
}

/**
 * Probe upward from HERE looking for the monorepo's pnpm-workspace.yaml
 * + soa-validate.lock pair — the two-file signature that uniquely
 * identifies the SOA-Harness impl monorepo. Returns the repo root if
 * found, null otherwise. Used by --link to decide whether the scaffold
 * call is inside the monorepo (and can register itself as a workspace
 * member) or outside (where --link is meaningless and MUST error).
 */
export function findMonorepoRoot(fromDir: string = HERE): string | null {
  let current = resolve(fromDir);
  for (let i = 0; i < 8; i++) {
    const workspaceYaml = join(current, "pnpm-workspace.yaml");
    const lockFile = join(current, "soa-validate.lock");
    if (existsSync(workspaceYaml) && existsSync(lockFile)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function spkiSha256Hex(certDerBase64: string): Promise<string> {
  const cert = new X509Certificate(Buffer.from(certDerBase64, "base64"));
  const hash = await webcrypto.subtle.digest("SHA-256", cert.publicKey.rawData);
  return Buffer.from(hash).toString("hex");
}

async function generateDemoCert(publisherKid: string): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify"
  ])) as CryptoKeyPair;
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${publisherKid},O=SOA-Harness Demo Self-Signed`,
    notBefore: new Date(Date.now() - 3600 * 1000),
    notAfter: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    signingAlgorithm: { name: "Ed25519" },
    keys
  });
  return Buffer.from(cert.rawData).toString("base64");
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const now = opts.now ?? new Date();
  const memory = opts.memory ?? DEFAULT_MEMORY_BACKEND;
  const templateRoot = resolveTemplateRoot(memory);
  if (!existsSync(templateRoot)) {
    throw new Error(`create-soa-agent: templates directory not found at ${templateRoot}`);
  }
  if (existsSync(opts.targetDir)) {
    throw new Error(`create-soa-agent: target ${opts.targetDir} already exists — refusing to overwrite`);
  }
  mkdirSync(opts.targetDir, { recursive: true });

  // Copy the selected template tree.
  cpSync(templateRoot, opts.targetDir, { recursive: true });

  // Generate a self-signed Ed25519 cert for the demo SPKI.
  const publisherKid = "soa-demo-publisher-v1.0";
  const certB64 = await generateDemoCert(publisherKid);
  const spki = await spkiSha256Hex(certB64);

  const { unlinkSync } = await import("node:fs");
  const filesWritten: string[] = [];
  const substitute = (relPath: string, replacements: Array<[string, string]>) => {
    const abs = join(opts.targetDir, relPath);
    let content = readFileSync(abs, "utf8");
    for (const [from, to] of replacements) content = content.split(from).join(to);
    writeFileSync(abs, content);
    filesWritten.push(relPath);
  };

  // Rename the .template stub → operational filename, then substitute.
  const trustTemplate = join(opts.targetDir, "initial-trust.template.json");
  const trustFinal = join(opts.targetDir, "initial-trust.json");
  if (existsSync(trustTemplate)) {
    const body = readFileSync(trustTemplate, "utf8")
      .split(PLACEHOLDER_SPKI)
      .join(spki)
      .split(PLACEHOLDER_ISSUED)
      .join(now.toISOString());
    writeFileSync(trustFinal, body);
    unlinkSync(trustTemplate);
    filesWritten.push("initial-trust.json");
  }

  substitute("agent-card.json", [[PLACEHOLDER_SPKI, spki]]);
  substitute("package.json", [[PLACEHOLDER_NAME, opts.projectName]]);

  console.warn(
    `[create-soa-agent] WARNING: generated a synthetic Ed25519 keypair + self-signed cert for local demo use only. ` +
      `The private key was NOT persisted; production deployments MUST supply an operator-issued key + cert chain ` +
      `(RUNNER_SIGNING_KEY + RUNNER_X5C).`
  );

  return {
    targetDir: opts.targetDir,
    filesWritten,
    publisherKid,
    spkiSha256: spki,
    linked: opts.link ?? false,
    memory
  };
}

/**
 * Resolve the effective target directory for a scaffold invocation.
 * With `link: true`, forces the scaffold under `<monorepo>/examples/<name>/`
 * so the resulting package joins the pnpm workspace via the `examples/*`
 * glob (added in Phase 0e E2(a)). Errors cleanly when --link is passed
 * from outside the monorepo.
 */
export function resolveTargetDir(args: {
  projectName: string;
  link: boolean;
  cwd: string;
  /** Override for tests; real CLI uses the module's HERE. */
  monorepoFromDir?: string;
}): string {
  if (!args.link) {
    return resolve(args.cwd, args.projectName);
  }
  const monorepo = findMonorepoRoot(args.monorepoFromDir);
  if (!monorepo) {
    throw new Error(
      "create-soa-agent: --link was passed but this CLI is not running from inside the SOA-Harness monorepo. " +
        "Re-run without --link to scaffold a standalone project, or invoke from a local monorepo checkout."
    );
  }
  return join(monorepo, "examples", args.projectName);
}

const MEMORY_CHOICES: readonly MemoryBackendChoice[] = ["sqlite", "mem0", "zep", "none"] as const;

function parseArgs(argv: readonly string[]):
  | { name: string; demo: boolean; link: boolean; memory: MemoryBackendChoice }
  | { help: true }
  | { error: string } {
  let name: string | undefined;
  let demo = false;
  let link = false;
  let memory: MemoryBackendChoice = DEFAULT_MEMORY_BACKEND;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      name = argv[++i];
    } else if (arg === "--demo") {
      demo = true;
    } else if (arg === "--link") {
      link = true;
    } else if (arg === "--memory") {
      const choice = argv[++i];
      if (!choice || !MEMORY_CHOICES.includes(choice as MemoryBackendChoice)) {
        return { error: `--memory must be one of ${MEMORY_CHOICES.join("|")}; got "${choice ?? "<missing>"}"` };
      }
      memory = choice as MemoryBackendChoice;
    } else if (arg && arg.startsWith("--memory=")) {
      const choice = arg.slice("--memory=".length);
      if (!MEMORY_CHOICES.includes(choice as MemoryBackendChoice)) {
        return { error: `--memory must be one of ${MEMORY_CHOICES.join("|")}; got "${choice}"` };
      }
      memory = choice as MemoryBackendChoice;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg === "demo" && !name) {
      // `create-soa-agent demo` shorthand — treat as --name demo-agent --demo.
      name = "demo-agent";
      demo = true;
    } else if (arg && !name) {
      name = arg;
    }
  }
  if (!name) return { help: true };
  return { name, demo, link, memory };
}

function printHelp(): void {
  console.log(
    [
      "Usage: create-soa-agent <project-name> [--demo] [--link] [--memory=<sqlite|mem0|zep|none>]",
      "",
      "  --name <name>          Project directory + package name (required).",
      "  --demo                 Shorthand for the demo scaffold.",
      "  --link                 In-monorepo dev mode: scaffold under <repo>/examples/<name>/",
      "                         so the workspace:* deps resolve via pnpm workspace linkage.",
      "                         Requires invocation from inside the SOA-Harness monorepo.",
      "  --memory <backend>     Memory MCP backend the demo boots against. Default: sqlite.",
      "                         sqlite — in-process @soa-harness/memory-mcp-sqlite on :8001",
      "                         mem0   — docker-compose Qdrant + mem0 shim (run memory:up first)",
      "                         zep    — docker-compose Zep server (run memory:up first)",
      "                         none   — M4 baseline, no memory wiring",
      "  --help, -h             Show this message.",
      "",
      "Writes a new directory matching <project-name> with:",
      "  agent-card.json          — ReadOnly demo Card (+ memory block for non-`none` variants)",
      "  initial-trust.json       — synthetic SDK-pinned trust root",
      "  tools.json               — 3-tool demo registry",
      "  hooks/pre-tool-use.mjs   — illustrative §15 hook",
      "  permission-decisions/auto-allow.json — first-boot decision body",
      "  start.mjs                — demo entrypoint driving the first audit row",
      "  docker-compose.yml       — present for mem0/zep variants"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    printHelp();
    return;
  }
  if ("error" in parsed) {
    console.error(`[create-soa-agent] ${parsed.error}`);
    process.exit(2);
  }
  const targetDir = resolveTargetDir({
    projectName: parsed.name,
    link: parsed.link,
    cwd: process.cwd(),
  });
  const result = await scaffold({
    projectName: parsed.name,
    targetDir,
    demo: parsed.demo,
    link: parsed.link,
    memory: parsed.memory
  });
  console.log(`[create-soa-agent] scaffolded ${result.filesWritten.length} files into ${result.targetDir}`);
  console.log(`[create-soa-agent]   publisher_kid: ${result.publisherKid}`);
  console.log(`[create-soa-agent]   spki_sha256:   ${result.spkiSha256}`);
  if (result.linked) {
    const monorepo = findMonorepoRoot();
    const relativeTarget = monorepo
      ? `examples/${parsed.name}`
      : result.targetDir;
    console.log(
      `[create-soa-agent] next: (cd ${monorepo ?? "<repo>"} && pnpm install && cd ${relativeTarget} && pnpm start)`
    );
    console.log(
      "[create-soa-agent] note: --link joined the pnpm workspace via examples/* glob; use pnpm not npm."
    );
  } else {
    console.log(`[create-soa-agent] next: (cd ${parsed.name} && npm install && node ./start.mjs)`);
  }
}

// Only run main() when invoked as a CLI — imports by tests skip it.
// Resolve symlinks on both sides so the check works under `npm install -g`
// on Linux / macOS where /usr/bin/<name> is symlinked to the real dist file.
// Windows uses .cmd wrappers (no symlink), so realpath is a no-op there.
const here = fileURLToPath(import.meta.url);
let invoker = "";
if (process.argv[1]) {
  try {
    invoker = realpathSync(process.argv[1]);
  } catch {
    invoker = process.argv[1];
  }
}
const invokedAsCli = here === invoker;
if (invokedAsCli) {
  main().catch((err) => {
    console.error("[create-soa-agent] FATAL:", err);
    process.exit(1);
  });
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
// Re-exported helper for tests / tooling; also silences "unused import" lint.
export { sha256Hex };
