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
