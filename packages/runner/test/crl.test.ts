import { describe, it, expect } from "vitest";
import { CrlCache, type Crl, type CrlFetcher } from "../src/crl/index.js";

const ANCHOR = "https://ca.test.local/soa-test";

function validCrl(overrides: Partial<Crl> = {}): Crl {
  return {
    issuer: "CN=Test CA",
    issued_at: "2026-04-20T00:00:00Z",
    not_after: "2026-04-21T00:00:00Z",
    revoked_kids: [
      { kid: "kid-revoked-1", revoked_at: "2026-04-20T01:00:00Z", reason: "compromise" }
    ],
    ...overrides
  };
}

function fetcher(responses: Crl[]): CrlFetcher {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!next) throw new Error("fetcher exhausted");
    return next;
  };
}

describe("CrlCache", () => {
  it("marks a kid 'fresh' immediately after a successful fetch", async () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const cache = new CrlCache({ fetcher: fetcher([validCrl()]), now: () => now });
    await cache.refresh(ANCHOR);

    const hit = cache.check(ANCHOR, "kid-unknown");
    expect(hit.freshness).toBe("fresh");
    expect(hit.revoked).toBe(false);
  });

  it("reports revoked:true when kid is listed", async () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const cache = new CrlCache({ fetcher: fetcher([validCrl()]), now: () => now });
    await cache.refresh(ANCHOR);

    const hit = cache.check(ANCHOR, "kid-revoked-1");
    expect(hit.revoked).toBe(true);
    expect(hit.revokedEntry?.reason).toBe("compromise");
  });

  it("transitions fresh → stale-but-valid past the refresh interval", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    const cache = new CrlCache({
      fetcher: fetcher([validCrl()]),
      refreshIntervalMs: 60 * 60 * 1000,
      staleCeilingMs: 2 * 60 * 60 * 1000,
      now: () => wall
    });
    await cache.refresh(ANCHOR);

    // +30min — still fresh
    wall = new Date("2026-04-20T12:30:00Z");
    expect(cache.check(ANCHOR, "kid-anything").freshness).toBe("fresh");

    // +90min — stale-but-valid
    wall = new Date("2026-04-20T13:30:00Z");
    expect(cache.check(ANCHOR, "kid-anything").freshness).toBe("stale-but-valid");
  });

  it("fails closed with crl-unreachable past the 2-hour ceiling", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    const cache = new CrlCache({
      fetcher: fetcher([validCrl()]),
      refreshIntervalMs: 60 * 60 * 1000,
      staleCeilingMs: 2 * 60 * 60 * 1000,
      now: () => wall
    });
    await cache.refresh(ANCHOR);

    wall = new Date("2026-04-20T14:30:00Z"); // +2h30m
    const hit = cache.check(ANCHOR, "kid-anything");
    expect(hit.freshness).toBe("expired");
    expect(hit.failureReason).toBe("crl-unreachable");
  });

  it("fails closed with crl-expired past the CRL's own not_after", async () => {
    let wall = new Date("2026-04-20T23:55:00Z");
    const cache = new CrlCache({
      fetcher: fetcher([validCrl({ not_after: "2026-04-21T00:00:00Z" })]),
      now: () => wall
    });
    await cache.refresh(ANCHOR);

    wall = new Date("2026-04-21T00:05:00Z"); // 5 minutes past not_after
    const hit = cache.check(ANCHOR, "kid-anything");
    expect(hit.freshness).toBe("expired");
    expect(hit.failureReason).toBe("crl-expired");
  });

  it("fails closed with crl-missing when no CRL has ever been fetched", () => {
    const cache = new CrlCache({ fetcher: fetcher([validCrl()]) });
    const hit = cache.check(ANCHOR, "kid-anything");
    expect(hit.freshness).toBe("expired");
    expect(hit.failureReason).toBe("crl-missing");
  });

  it("rejects a CRL that fails crl.schema.json", async () => {
    const badCrl = { issuer: "CN=Bad", issued_at: "not-a-date" } as unknown as Crl;
    const cache = new CrlCache({ fetcher: async () => badCrl });
    await expect(cache.refresh(ANCHOR)).rejects.toThrow(/crl\.schema\.json/);
  });

  it("refresh replaces the cached CRL and updates fetchedAt", async () => {
    let wall = new Date("2026-04-20T12:00:00Z");
    const first = validCrl({ not_after: "2026-04-21T00:00:00Z" });
    const second = validCrl({
      not_after: "2026-04-22T00:00:00Z",
      revoked_kids: [
        ...first.revoked_kids,
        { kid: "kid-revoked-2", revoked_at: "2026-04-21T01:00:00Z", reason: "rotation" }
      ]
    });
    const cache = new CrlCache({ fetcher: fetcher([first, second]), now: () => wall });

    await cache.refresh(ANCHOR);
    expect(cache.check(ANCHOR, "kid-revoked-2").revoked).toBe(false);

    wall = new Date("2026-04-20T13:30:00Z"); // +90min — would be stale
    await cache.refresh(ANCHOR);
    // After refresh, fetchedAt moved to the new wall-clock time, so back to fresh
    expect(cache.check(ANCHOR, "kid-anything").freshness).toBe("fresh");
    expect(cache.check(ANCHOR, "kid-revoked-2").revoked).toBe(true);
  });
});
