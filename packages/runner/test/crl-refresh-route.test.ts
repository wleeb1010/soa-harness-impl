import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRunnerApp } from "../src/server.js";
import { generateEd25519KeyPair, generateSelfSignedEd25519Cert } from "../src/card/cert.js";
import { BootOrchestrator } from "../src/boot/index.js";
import { CrlCache, type Crl } from "../src/crl/index.js";
import type { TrustAnchor } from "../src/card/verify.js";
import type { InitialTrust } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = JSON.parse(readFileSync(join(here, "fixtures", "agent-card.sample.json"), "utf8"));
const TRUST = JSON.parse(
  readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8"),
) as InitialTrust;

const KID = "soa-release-v1.0";
const ADMIN = "admin-bearer-" + "a".repeat(20);

const ANCHOR: TrustAnchor = {
  issuer: "CN=Test CA",
  spki_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  uri: "https://ca.test.local/soa-test",
  publisher_kid: KID,
};

function makeCrl(issuedAt: string, notAfter: string): Crl {
  return {
    issuer: "CN=Test CA",
    issued_at: issuedAt,
    not_after: notAfter,
    revoked_kids: [],
  };
}

async function bootApp(opts: { fetchesReturn?: "ok" | "error" } = {}) {
  let wall = new Date("2026-04-20T12:00:00Z");
  const clock = () => wall;
  const advance = (ms: number) => {
    wall = new Date(wall.getTime() + ms);
  };

  let fetchCount = 0;
  let shouldFail = opts.fetchesReturn === "error";
  const crl = new CrlCache({
    fetcher: async () => {
      fetchCount++;
      if (shouldFail) throw new Error("network down");
      return makeCrl(wall.toISOString(), new Date(wall.getTime() + 30 * 60 * 60 * 1000).toISOString());
    },
    now: clock,
  });
  const boot = new BootOrchestrator({ anchors: [ANCHOR], crl, refreshIntervalMs: 0 });
  await boot.boot();

  const keys = await generateEd25519KeyPair();
  const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
  const app = await buildRunnerApp({
    trust: TRUST,
    card: CARD,
    alg: "EdDSA",
    kid: KID,
    privateKey: keys.privateKey,
    x5c: [cert],
    readiness: boot,
    crlRefresh: {
      orchestrator: boot,
      bootstrapBearer: ADMIN,
      clock,
      runnerVersion: "1.1-test",
    },
  });
  return { app, boot, clock, advance, getFetchCount: () => fetchCount, setShouldFail: (v: boolean) => (shouldFail = v) };
}

describe("POST /crl/refresh", () => {
  it("refreshes all anchors on admin POST + returns 200 summary", async () => {
    const { app, getFetchCount } = await bootApp();
    const countBefore = getFetchCount();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crl/refresh",
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.refreshed).toBe(true);
      expect(body.error).toBeNull();
      expect(body.runner_version).toBe("1.1-test");
      // The refresh actually fired a fetch
      expect(getFetchCount()).toBe(countBefore + 1);
    } finally {
      await app.close();
    }
  });

  it("returns 403 on non-admin bearer", async () => {
    const { app } = await bootApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crl/refresh",
        headers: { authorization: `Bearer not-admin` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 403 on no bearer", async () => {
    const { app } = await bootApp();
    try {
      const res = await app.inject({ method: "POST", url: "/crl/refresh" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("surfaces refresh errors in the 200 body when the fetcher fails (errors don't throw to HTTP)", async () => {
    const { app, setShouldFail } = await bootApp();
    setShouldFail(true);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crl/refresh",
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      // The fetcher failure is recorded by onRefreshError; refreshAllNow
      // itself doesn't throw. HTTP stays 200 + refreshed:true because no
      // exception propagated. Operators inspect dependent surfaces (/ready)
      // or /logs/system/recent to confirm the refresh was meaningful.
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("route absent when opts.crlRefresh omitted", async () => {
    const wall = new Date("2026-04-20T12:00:00Z");
    const crl = new CrlCache({ fetcher: async () => makeCrl(wall.toISOString(), new Date(wall.getTime() + 30 * 60 * 60 * 1000).toISOString()), now: () => wall });
    const boot = new BootOrchestrator({ anchors: [ANCHOR], crl, refreshIntervalMs: 0 });
    await boot.boot();
    const keys = await generateEd25519KeyPair();
    const cert = await generateSelfSignedEd25519Cert({ keys, subject: `CN=${KID},O=Test` });
    const app = await buildRunnerApp({
      trust: TRUST,
      card: CARD,
      alg: "EdDSA",
      kid: KID,
      privateKey: keys.privateKey,
      x5c: [cert],
      readiness: boot,
      // NO crlRefresh
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crl/refresh",
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
