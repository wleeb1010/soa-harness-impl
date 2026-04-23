#!/usr/bin/env node
import "reflect-metadata";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate, X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

type CryptoKeyPair = webcrypto.CryptoKeyPair;

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = join(HERE, "..", "templates", "runner-starter");

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
  now?: Date;
}

export interface ScaffoldResult {
  targetDir: string;
  filesWritten: string[];
  publisherKid: string;
  spkiSha256: string;
  /** True iff scaffold was placed under the monorepo's examples/ glob. */
  linked: boolean;
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
  if (!existsSync(TEMPLATE_ROOT)) {
    throw new Error(`create-soa-agent: templates directory not found at ${TEMPLATE_ROOT}`);
  }
  if (existsSync(opts.targetDir)) {
    throw new Error(`create-soa-agent: target ${opts.targetDir} already exists — refusing to overwrite`);
  }
  mkdirSync(opts.targetDir, { recursive: true });

  // Copy the full template tree.
  cpSync(TEMPLATE_ROOT, opts.targetDir, { recursive: true });

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

function parseArgs(argv: readonly string[]):
  | { name: string; demo: boolean; link: boolean }
  | { help: true } {
  let name: string | undefined;
  let demo = false;
  let link = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      name = argv[++i];
    } else if (arg === "--demo") {
      demo = true;
    } else if (arg === "--link") {
      link = true;
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
  return { name, demo, link };
}

function printHelp(): void {
  console.log(
    [
      "Usage: create-soa-agent <project-name> [--demo] [--link]",
      "",
      "  --name <name>    Project directory + package name (required).",
      "  --demo           Shorthand for the demo scaffold (same default template in M1).",
      "  --link           In-monorepo dev mode: scaffold under <repo>/examples/<name>/",
      "                   so the workspace:* deps resolve via pnpm workspace linkage.",
      "                   Requires invocation from inside the SOA-Harness monorepo.",
      "  --help, -h       Show this message.",
      "",
      "Writes a new directory matching <project-name> with:",
      "  agent-card.json          — ReadOnly demo Card",
      "  initial-trust.json       — synthetic SDK-pinned trust root",
      "  tools.json               — 3-tool demo registry",
      "  hooks/pre-tool-use.mjs   — illustrative §15 hook",
      "  permission-decisions/auto-allow.json — first-boot decision body",
      "  start.mjs                — demo entrypoint driving the first audit row"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    printHelp();
    return;
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
    console.log(
      "[create-soa-agent] note: until @soa-harness/* packages are npm-published, the " +
        "default scaffold's `workspace:*` deps will NOT resolve with bare `npm install`. " +
        "Re-run with --link if you are inside the monorepo checkout."
    );
  }
}

// Only run main() when invoked as a CLI — imports by tests skip it.
const invokedAsCli = fileURLToPath(import.meta.url) === process.argv[1];
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
