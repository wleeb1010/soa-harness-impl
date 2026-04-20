import { describe, it, expect } from "vitest";
import { createClock, TestClockInProductionError } from "../src/clock/index.js";
import { CrlCache, type Crl } from "../src/crl/index.js";

const VALID_CRL: Crl = {
  issuer: "CN=Test CA",
  issued_at: "2026-04-20T00:00:00Z",
  not_after: "2026-04-21T00:00:00Z",
  revoked_kids: []
};

describe("createClock (L-01)", () => {
  it("returns a wall-clock when RUNNER_TEST_CLOCK is unset", () => {
    const clock = createClock({ envClock: undefined });
    const t1 = clock();
    const t2 = clock();
    expect(t2.getTime()).toBeGreaterThanOrEqual(t1.getTime());
  });

  it("returns a frozen clock when RUNNER_TEST_CLOCK is a valid ISO 8601 value", () => {
    const clock = createClock({ envClock: "2026-04-20T12:00:00Z" });
    expect(clock().toISOString()).toBe("2026-04-20T12:00:00.000Z");
    expect(clock().toISOString()).toBe("2026-04-20T12:00:00.000Z");
  });

  it("refuses to start when RUNNER_TEST_CLOCK is set AND NODE_ENV=production", () => {
    expect(() =>
      createClock({ envClock: "2026-04-20T12:00:00Z", nodeEnv: "production" })
    ).toThrow(TestClockInProductionError);
  });

  it("refuses to start when TLS is serving on a non-loopback host", () => {
    expect(() =>
      createClock({
        envClock: "2026-04-20T12:00:00Z",
        tlsEnabled: true,
        host: "runner.example.com"
      })
    ).toThrow(TestClockInProductionError);
  });

  it("allows TLS on loopback hosts", () => {
    const clock = createClock({
      envClock: "2026-04-20T12:00:00Z",
      tlsEnabled: true,
      host: "127.0.0.1"
    });
    expect(clock().toISOString()).toBe("2026-04-20T12:00:00.000Z");
  });

  it("treats 0.0.0.0 + TLS as non-loopback (fires the guard)", () => {
    // 0.0.0.0 binds on all interfaces including non-loopback; the guard should
    // fire to prevent exposing the test-clock hook over a public interface.
    expect(() =>
      createClock({ envClock: "2026-04-20T12:00:00Z", tlsEnabled: true, host: "0.0.0.0" })
    ).toThrow(TestClockInProductionError);
  });

  it("rejects an unparseable RUNNER_TEST_CLOCK value", () => {
    expect(() => createClock({ envClock: "not-a-timestamp" })).toThrow(
      /not a valid ISO 8601/
    );
  });
});

describe("CrlCache under an injected clock", () => {
  it("exercises all three freshness states deterministically", async () => {
    let wall = createClock({ envClock: "2026-04-20T12:00:00Z" })();
    const cache = new CrlCache({
      fetcher: async () => VALID_CRL,
      refreshIntervalMs: 60 * 60 * 1000,
      staleCeilingMs: 2 * 60 * 60 * 1000,
      now: () => wall
    });

    await cache.refresh("https://ca.test/anchor");
    expect(cache.check("https://ca.test/anchor", "kid-x").freshness).toBe("fresh");

    wall = new Date("2026-04-20T13:30:00Z"); // +90 minutes
    expect(cache.check("https://ca.test/anchor", "kid-x").freshness).toBe("stale-but-valid");

    wall = new Date("2026-04-20T14:30:00Z"); // +2h30m past ceiling
    const expired = cache.check("https://ca.test/anchor", "kid-x");
    expect(expired.freshness).toBe("expired");
    expect(expired.failureReason).toBe("crl-unreachable");
  });
});
