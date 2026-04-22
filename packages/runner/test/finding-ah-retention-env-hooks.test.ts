import { describe, it, expect } from "vitest";
import {
  parseRetentionSweepEnv,
  assertRetentionSweepListenerSafe,
  RetentionSweepHookOnPublicListener,
  RetentionSweepScheduler
} from "../src/privacy/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";

// Finding AH — §10.7.3 SV-PRIV-04 retention-sweep env-hook parser + guard.

const FROZEN = new Date("2026-04-22T15:00:00.000Z");

describe("Finding AH — parseRetentionSweepEnv", () => {
  it("both unset → empty config", () => {
    expect(parseRetentionSweepEnv({})).toEqual({});
  });

  it("RUNNER_RETENTION_SWEEP_TICK_MS=250 → tickIntervalMs:250", () => {
    expect(parseRetentionSweepEnv({ RUNNER_RETENTION_SWEEP_TICK_MS: "250" })).toEqual({
      tickIntervalMs: 250
    });
  });

  it("RUNNER_RETENTION_SWEEP_INTERVAL_MS=0 → intervalMs:0", () => {
    expect(parseRetentionSweepEnv({ RUNNER_RETENTION_SWEEP_INTERVAL_MS: "0" })).toEqual({
      intervalMs: 0
    });
  });

  it("both set → both returned", () => {
    expect(
      parseRetentionSweepEnv({
        RUNNER_RETENTION_SWEEP_TICK_MS: "100",
        RUNNER_RETENTION_SWEEP_INTERVAL_MS: "500"
      })
    ).toEqual({ tickIntervalMs: 100, intervalMs: 500 });
  });

  it("tick non-integer → throws positive-integer", () => {
    expect(() =>
      parseRetentionSweepEnv({ RUNNER_RETENTION_SWEEP_TICK_MS: "not-a-number" })
    ).toThrow(/positive integer/);
  });

  it("tick zero → throws positive-integer", () => {
    expect(() =>
      parseRetentionSweepEnv({ RUNNER_RETENTION_SWEEP_TICK_MS: "0" })
    ).toThrow(/positive integer/);
  });

  it("interval negative → throws non-negative-integer", () => {
    expect(() =>
      parseRetentionSweepEnv({ RUNNER_RETENTION_SWEEP_INTERVAL_MS: "-1" })
    ).toThrow(/non-negative integer/);
  });
});

describe("Finding AH — assertRetentionSweepListenerSafe", () => {
  it("no env set → no throw on any host", () => {
    expect(() =>
      assertRetentionSweepListenerSafe({ env: {}, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("env set + loopback → allowed", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(() =>
        assertRetentionSweepListenerSafe({ env: { tickIntervalMs: 100 }, host })
      ).not.toThrow();
    }
  });

  it("env set + non-loopback → RetentionSweepHookOnPublicListener", () => {
    expect(() =>
      assertRetentionSweepListenerSafe({
        env: { tickIntervalMs: 100 },
        host: "0.0.0.0"
      })
    ).toThrow(RetentionSweepHookOnPublicListener);
    expect(() =>
      assertRetentionSweepListenerSafe({
        env: { intervalMs: 1000 },
        host: "192.168.1.5"
      })
    ).toThrow(RetentionSweepHookOnPublicListener);
  });
});

describe("Finding AH — scheduler honors parsed env config", () => {
  it("env-supplied tickIntervalMs + intervalMs drive the fast-tick sweep", () => {
    let now = new Date(FROZEN);
    const ticks: (() => void)[] = [];
    const buf = new SystemLogBuffer({ clock: () => now });
    const sweeper = new RetentionSweepScheduler({
      clock: () => now,
      log: () => undefined,
      systemLog: buf,
      tickIntervalMs: 100,
      intervalMs: 500,
      setInterval: ((fn: () => void): ReturnType<typeof setInterval> => {
        ticks.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as unknown as typeof clearInterval
    });
    sweeper.start();
    // First tick at 100ms elapsed — interval is 500ms so no fire yet.
    now = new Date(now.getTime() + 100);
    ticks[0]?.();
    expect(sweeper.outcomesSnapshot().length).toBe(0);
    // Advance past 500ms — next tick fires.
    now = new Date(now.getTime() + 500);
    ticks[0]?.();
    expect(sweeper.outcomesSnapshot().length).toBe(1);
    sweeper.stop();
    // System-log surface picked up the sweep.
    const sweepLogs = buf
      .snapshot("ses_runner_boot_____")
      .filter((r) => r.code === "retention-sweep-ran");
    expect(sweepLogs.length).toBe(1);
  });
});
