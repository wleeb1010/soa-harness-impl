import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadInitialTrust, HostHardeningInsufficient } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "soa-harness=specification",
  "test-vectors",
  "initial-trust"
);

const PINNED_KID = "soa-test-release-v1.0";
// A fixed "now" that's inside valid.json's window (2026-01 → 2099-12) but
// well past expired.json's not_after (2020-06-30).
const NOW = new Date("2026-04-20T12:00:00.000Z");

describe("T-07 RUNNER_INITIAL_TRUST — SV-BOOT-01 negatives", () => {
  it("valid.json → loads clean (happy regression)", () => {
    const trust = loadInitialTrust({
      path: join(FIXTURE_DIR, "valid.json"),
      expectedPublisherKid: PINNED_KID,
      now: NOW
    });
    expect(trust.publisher_kid).toBe(PINNED_KID);
    expect(trust.channel).toBe("operator-bundled");
  });

  it("expired.json → HostHardeningInsufficient reason=bootstrap-expired", () => {
    try {
      loadInitialTrust({
        path: join(FIXTURE_DIR, "expired.json"),
        expectedPublisherKid: PINNED_KID,
        now: NOW
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-expired");
      return;
    }
    throw new Error("expected HostHardeningInsufficient");
  });

  it("channel-mismatch.json → HostHardeningInsufficient reason=bootstrap-invalid-schema", () => {
    try {
      loadInitialTrust({
        path: join(FIXTURE_DIR, "channel-mismatch.json"),
        expectedPublisherKid: PINNED_KID,
        now: NOW
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      // channel="stolen-secrets" fails the schema enum — hits the schema stage,
      // not the post-parse channel check.
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-invalid-schema");
      return;
    }
    throw new Error("expected HostHardeningInsufficient");
  });

  it("mismatched-publisher-kid.json → HostHardeningInsufficient reason=bootstrap-missing", () => {
    try {
      loadInitialTrust({
        path: join(FIXTURE_DIR, "mismatched-publisher-kid.json"),
        expectedPublisherKid: PINNED_KID,
        now: NOW
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-missing");
      return;
    }
    throw new Error("expected HostHardeningInsufficient");
  });
});
