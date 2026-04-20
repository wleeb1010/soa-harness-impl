import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import { buildRunnerApp } from "../src/server.js";
import type { ReadinessProbe, ReadinessReason } from "../src/probes/index.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8")
) as InitialTrust;
const KID = "soa-release-v1.0";

async function newApp(readiness?: ReadinessProbe) {
  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
  const buildOpts = {
    trust: TRUST,
    card: CARD,
    alg: "EdDSA" as const,
    kid: KID,
    privateKey: keys.privateKey,
    x5c: [cert]
  };
  return readiness ? buildRunnerApp({ ...buildOpts, readiness }) : buildRunnerApp(buildOpts);
}

describe("/health (§5.4 liveness)", () => {
  it("always returns 200 with the fixed body shape", async () => {
    const app = await newApp();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: "alive", soaHarnessVersion: "1.0" });
    } finally {
      await app.close();
    }
  });

  it("does NOT require authentication (no challenge on unauthenticated GET)", async () => {
    const app = await newApp();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.headers["www-authenticate"]).toBeUndefined();
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("/ready (§5.4 readiness)", () => {
  it("returns 200 {status:ready} when the readiness probe passes", async () => {
    const app = await newApp();
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("returns 503 {status:not-ready,reason:<enum>} when the probe reports a failure", async () => {
    const failing: ReadinessProbe = { check: () => "bootstrap-pending" };
    const app = await newApp(failing);
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ status: "not-ready", reason: "bootstrap-pending" });
    } finally {
      await app.close();
    }
  });

  it("surfaces each closed-enum reason without modification", async () => {
    const reasons: ReadinessReason[] = [
      "bootstrap-pending",
      "tool-pool-initializing",
      "persistence-unwritable",
      "audit-sink-unreachable",
      "crl-stale"
    ];
    for (const reason of reasons) {
      const app = await newApp({ check: () => reason });
      try {
        const res = await app.inject({ method: "GET", url: "/ready" });
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body).reason).toBe(reason);
      } finally {
        await app.close();
      }
    }
  });

  it("flips 503 → 200 when the underlying probe transitions to ready", async () => {
    let ready = false;
    const dynamic: ReadinessProbe = { check: () => (ready ? null : "bootstrap-pending") };
    const app = await newApp(dynamic);
    try {
      const before = await app.inject({ method: "GET", url: "/ready" });
      expect(before.statusCode).toBe(503);
      ready = true;
      const after = await app.inject({ method: "GET", url: "/ready" });
      expect(after.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
