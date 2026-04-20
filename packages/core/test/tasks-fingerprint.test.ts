import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTasksFingerprint } from "../src/tasks-fingerprint.js";

// Resolve the sibling spec repo from this test file, not from process.cwd().
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const specRoot = join(repoRoot, "..", "soa-harness=specification");
const tasksDir = join(specRoot, "test-vectors", "tasks-fingerprint", "tasks");

// Expected values are the output of the spec's test-vectors/tasks-fingerprint/compute.mjs
// at the spec commit pinned in soa-validate.lock. If these drift, either the spec
// changed the fixtures or our port has a bug — both require investigation, not a silent bump.
const EXPECTED_FINGERPRINT =
  "sha256:8315851bf50e45dd0e3a0ec328264ae41e1acf714ccc70f5a8c3b73dd2212237";
const EXPECTED_ENTRIES = {
  "alpha-adder": {
    task_json_sha256: "5ccf36295e0b9a35f75c4fc66402f107aafce349fd492301bee442316e981f6d",
    dockerfile_sha256: "4595c4ac2e960e0da3bfecced1fe725eacbf007fe0ce1c3dd7caa50fa54ff8ae",
    entrypoint_sha256: "e912f7f9932f2b312ceb23ab5a635445bb52aaab7095f45ba81ab0f546df0956"
  },
  "beta-regex": {
    task_json_sha256: "1e242158fe0b4368b28372d919d464650be8c975af9035e4d3a0806f77cb04da",
    dockerfile_sha256: "12e1e32bf71fccc28c0125c168cd7d80569688d6e1169469188bf3462f82dbcc",
    entrypoint_sha256: "absent"
  }
} as const;

function readPinnedSpecSha(): string {
  const lockPath = join(repoRoot, "soa-validate.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { spec_commit_sha: string };
  return lock.spec_commit_sha;
}

function siblingSpecAtPin(): boolean {
  if (!existsSync(specRoot)) return false;
  try {
    const head = execSync("git rev-parse HEAD", { cwd: specRoot, encoding: "utf8" }).trim();
    return head === readPinnedSpecSha();
  } catch {
    return false;
  }
}

describe("computeTasksFingerprint (parity with spec reference at pinned commit)", () => {
  it.runIf(siblingSpecAtPin())("matches the spec's compute.mjs output byte for byte", () => {
    const { entries, fingerprint } = computeTasksFingerprint(tasksDir);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const expected = EXPECTED_ENTRIES[entry.task_id as keyof typeof EXPECTED_ENTRIES];
      expect(expected, `unexpected task_id ${entry.task_id}`).toBeDefined();
      expect(entry.task_json_sha256).toBe(expected.task_json_sha256);
      expect(entry.dockerfile_sha256).toBe(expected.dockerfile_sha256);
      expect(entry.entrypoint_sha256).toBe(expected.entrypoint_sha256);
    }
    expect(fingerprint).toBe(EXPECTED_FINGERPRINT);
  });

  it("skips cleanly when sibling spec repo is not at the pinned commit", () => {
    if (siblingSpecAtPin()) {
      expect(true).toBe(true); // sibling present and pinned; parity test ran
    } else {
      // Emit a clear diagnostic so CI reports "deferred" instead of a cryptic skip.
      console.warn(
        `[tasks-fingerprint] skipped: sibling spec repo at ${specRoot} is not at pinned commit ${readPinnedSpecSha().slice(0, 12)}. Run the parity test in CI where the spec is checked out at the pin, or bump the pin via the protocol.`
      );
      expect(true).toBe(true);
    }
  });
});
