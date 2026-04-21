import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BootOrchestrator } from "../src/boot/index.js";
import { CrlCache, type Crl } from "../src/crl/index.js";
import type { TrustAnchor } from "../src/card/verify.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import { buildRunnerApp } from "../src/server.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8")
) as InitialTrust;

const ANCHOR: TrustAnchor = {
  issuer: "CN=Test CA",
  spki_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  uri: "https://ca.test.local/soa-test",
  publisher_kid: "soa-release-v1.0"
};

function makeCrl(): Crl {
  return {
    issuer: "CN=Test CA",
    issued_at: "2026-04-20T00:00:00Z",
    not_after: "2026-04-21T00:00:00Z",
    revoked_kids: []
  };
}

describe("BootOrchestrator", () => {
  it("reports bootstrap-pending before boot() runs", () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });
    expect(boot.check()).toBe("bootstrap-pending");
  });

  it("flips to ready (null) after boot() warms every anchor", async () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });
    await boot.boot();
    expect(boot.isBooted).toBe(true);
    expect(boot.check()).toBeNull();
  });

  it("surfaces crl-stale when a fetcher fails during boot", async () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({
      fetcher: async () => {
        throw new Error("network down");
      },
      now: () => wall
    });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });
    await expect(boot.boot()).rejects.toThrow();
    expect(boot.isBooted).toBe(false);
    expect(boot.check()).toBe("crl-stale");
  });

  it("flips back to crl-stale when cache goes stale past the 2h ceiling", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });
    await boot.boot();
    expect(boot.check()).toBeNull();

    // Simulate the CRL endpoint going dark — no refresh occurs. Advance wall-
    // clock past the 2h ceiling and the probe MUST transition 200 → 503.
    wall = new Date("2026-04-20T14:30:00Z");
    expect(boot.check()).toBe("crl-stale");
  });

  it("flips back to crl-stale when the CRL's own not_after has passed", async () => {
    let wall = new Date("2026-04-20T23:55:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });
    await boot.boot();
    expect(boot.check()).toBeNull();

    wall = new Date("2026-04-21T00:05:00Z");
    expect(boot.check()).toBe("crl-stale");
  });

  it("§10.6 auto-refresh scheduler keeps /ready green across the 2h stale ceiling", async () => {
    // Reproduces the validator's long-running /ready=503 crl-stale finding.
    // Without the scheduler, a Runner up for > 2h with no manual refresh
    // ages the CRL cache past staleCeilingMs and check() returns crl-stale.
    // With the scheduler firing a refresh before the ceiling hits, the
    // cache's fetchedAt advances and the probe stays green.
    let wall = new Date("2026-04-20T12:00:00Z");
    let fetchCount = 0;
    const crl = new CrlCache({
      fetcher: async () => {
        fetchCount++;
        // Return a CRL with a long not_after so the "past not_after" branch
        // doesn't fire; we're isolating the stale-ceiling path.
        return {
          issuer: "CN=Test CA",
          issued_at: wall.toISOString(),
          not_after: new Date(wall.getTime() + 30 * 60 * 60 * 1000).toISOString(),
          revoked_kids: []
        };
      },
      now: () => wall
    });
    const boot = new BootOrchestrator({
      anchors: [ANCHOR],
      crl,
      refreshIntervalMs: 0 // disable the real timer; drive refreshes manually
    });
    await boot.boot();
    expect(fetchCount).toBe(1);
    expect(boot.check()).toBeNull();

    // Advance 1h — still fresh (within refreshIntervalMs of the cache).
    wall = new Date("2026-04-20T13:00:00Z");
    expect(boot.check()).toBeNull();

    // Advance past the 2h ceiling WITHOUT a scheduled refresh — regression
    // path: /ready flips 503. This is the validator-observed behavior.
    wall = new Date("2026-04-20T14:30:00Z");
    expect(boot.check()).toBe("crl-stale");

    // The fix: the scheduler fires refreshAllNow before the ceiling hits.
    // Drive a refresh manually to simulate the scheduled tick, then advance
    // wall-clock back under the ceiling relative to the new fetchedAt.
    wall = new Date("2026-04-20T13:45:00Z");
    await boot.refreshAllNow();
    expect(fetchCount).toBe(2);
    wall = new Date("2026-04-20T15:30:00Z"); // 1h45m past last refresh
    expect(boot.check()).toBeNull();

    // Another 3h without a refresh → stale again; another manual refresh fixes.
    wall = new Date("2026-04-20T18:30:00Z");
    expect(boot.check()).toBe("crl-stale");
    await boot.refreshAllNow();
    expect(fetchCount).toBe(3);
    wall = new Date("2026-04-20T19:00:00Z");
    expect(boot.check()).toBeNull();

    boot.stop();
  });

  it("stop() is idempotent and safe when called pre-boot", () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl, refreshIntervalMs: 0 });
    // Calling stop before boot is a no-op.
    expect(() => boot.stop()).not.toThrow();
    expect(() => boot.stop()).not.toThrow();
  });

  it("refresh-failure after boot logs via onRefreshError but keeps last-good CRL", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    let shouldFail = false;
    const crl = new CrlCache({
      fetcher: async () => {
        if (shouldFail) throw new Error("network down");
        return {
          issuer: "CN=Test CA",
          issued_at: wall.toISOString(),
          not_after: new Date(wall.getTime() + 30 * 60 * 60 * 1000).toISOString(),
          revoked_kids: []
        };
      },
      now: () => wall
    });
    const errors: Array<[string, unknown]> = [];
    const boot = new BootOrchestrator({
      anchors: [ANCHOR],
      crl,
      refreshIntervalMs: 0,
      onRefreshError: (uri, err) => errors.push([uri, err])
    });
    await boot.boot();
    expect(boot.check()).toBeNull();

    // A scheduler tick fails — cache keeps the last-good entry, error is
    // captured, /ready stays green until the stale ceiling is crossed.
    shouldFail = true;
    wall = new Date("2026-04-20T13:00:00Z");
    await boot.refreshAllNow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe(`${ANCHOR.uri}/crl.json`);
    expect(boot.check()).toBeNull();
  });

  it("reports tool-pool-initializing when the predicate is false post-boot", async () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    let poolReady = false;
    const boot = new BootOrchestrator({
      anchors: [ANCHOR],
      crl,
      toolPoolReady: () => poolReady
    });
    await boot.boot();
    expect(boot.check()).toBe("tool-pool-initializing");
    poolReady = true;
    expect(boot.check()).toBeNull();
  });
});

describe("Runner /ready under a BootOrchestrator", () => {
  it("returns 503 {crl-stale} pre-boot, 200 post-boot, 503 on re-degradation", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl });

    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: "CN=soa-release-v1.0,O=Test" });
    const app = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: "soa-release-v1.0",
      privateKey: keys.privateKey,
      x5c: [cert],
      readiness: boot
    });

    try {
      const pre = await app.inject({ method: "GET", url: "/ready" });
      expect(pre.statusCode).toBe(503);
      expect(JSON.parse(pre.body).reason).toBe("bootstrap-pending");

      await boot.boot();
      const post = await app.inject({ method: "GET", url: "/ready" });
      expect(post.statusCode).toBe(200);
      expect(JSON.parse(post.body)).toEqual({ status: "ready" });

      // Simulate CRL endpoint going dark; wall advances past 2h ceiling.
      wall = new Date("2026-04-20T14:30:00Z");
      const degraded = await app.inject({ method: "GET", url: "/ready" });
      expect(degraded.statusCode).toBe(503);
      expect(JSON.parse(degraded.body).reason).toBe("crl-stale");
    } finally {
      await app.close();
    }
  });
});
