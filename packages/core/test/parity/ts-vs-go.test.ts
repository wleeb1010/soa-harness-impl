import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "../../src/jcs.js";

// Cross-language JCS parity — this test consumes ONLY the generated vectors
// committed by the spec repo's test-vectors/jcs-parity/generate-vectors.mjs at the
// commit pinned in soa-validate.lock. We do NOT re-run the Go side here; the
// spec-repo generator is the source of truth for cross-language agreement, and
// an `expected_canonical` field exists only when both libraries agreed byte for
// byte. Our job is to verify our `canonicalize` wrapper agrees with that
// recorded output — nothing more, nothing less.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const specRoot = join(repoRoot, "..", "soa-harness=specification");
const generatedDir = join(specRoot, "test-vectors", "jcs-parity", "generated");

const EXPECTED_FILES = ["floats.json", "integers.json", "strings.json", "nested.json"] as const;

interface GeneratedCase {
  name: string;
  input: unknown;
  rationale?: string;
  libraries_agree: boolean;
  expected_canonical?: string;
  ts_output?: string;
  go_output?: string;
  error_ts?: string | null;
  error_go?: string | null;
  MANUAL_RESOLUTION_REQUIRED?: string;
}

interface GeneratedFile {
  libraries: Record<string, { name: string; version: string }>;
  source_inputs: string;
  cases: GeneratedCase[];
}

function loadGenerated(filename: string): { present: boolean; parsed: GeneratedFile | null; path: string } {
  const path = join(generatedDir, filename);
  if (!existsSync(path)) return { present: false, parsed: null, path };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GeneratedFile;
    return { present: true, parsed, path };
  } catch {
    return { present: true, parsed: null, path };
  }
}

describe("JCS cross-language parity (consumes pinned spec-generated vectors)", () => {
  it("spec repo's generated/ directory exists at the pinned commit", () => {
    expect(
      existsSync(generatedDir),
      `generated/ directory missing at ${generatedDir}. Run the spec-repo generator ` +
        `(test-vectors/jcs-parity/generate-vectors.mjs) against the pinned commit and commit the outputs.`
    ).toBe(true);
  });

  for (const filename of EXPECTED_FILES) {
    describe(filename, () => {
      const { present, parsed, path } = loadGenerated(filename);

      it("is present and parses as JSON", () => {
        expect(present, `${path} missing — spec generator has not emitted this vector yet`).toBe(true);
        expect(parsed, `${path} is present but unparseable`).not.toBeNull();
      });

      if (!parsed) return;

      it("every case reports libraries_agree === true", () => {
        const divergent = parsed.cases.filter((c) => !c.libraries_agree);
        const summary = divergent.map((c) => ({
          name: c.name,
          reason: c.MANUAL_RESOLUTION_REQUIRED ?? "(no reason given)",
          ts: c.ts_output ?? c.error_ts ?? null,
          go: c.go_output ?? c.error_go ?? null
        }));
        expect(
          summary,
          `${divergent.length} case(s) in ${filename} report library divergence. ` +
            `Do not override here — this is a spec-repo escalation (open an issue against soa-harness-specification referencing generate-vectors.mjs).`
        ).toEqual([]);
      });

      it("our jcs() reproduces expected_canonical for every agreed case", () => {
        for (const c of parsed.cases) {
          if (!c.libraries_agree) continue;
          if (typeof c.expected_canonical !== "string") {
            throw new Error(
              `case "${c.name}" in ${filename}: libraries_agree=true but expected_canonical is missing; ` +
                `generator output is malformed.`
            );
          }
          const ours = jcs(c.input);
          expect(
            ours,
            `case "${c.name}" in ${filename}: our canonicalize() diverges from the cross-library-verified output`
          ).toBe(c.expected_canonical);
        }
      });
    });
  }
});
