import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandlerKeyRegistry,
  HandlerKeyExpired,
  HandlerKeyRevoked,
  HandlerKidConflict,
  AlgorithmRejected,
  HandlerEnvHookOnPublicListener,
  parseHandlerEnv,
  assertHandlerEnvListenerSafe,
  loadOverlapKeypairs,
  HandlerCrlPoller
} from "../src/attestation/index.js";
import { SystemLogBuffer } from "../src/system-log/index.js";

// Finding BD/BE/BF — §10.6.2 handler key lifecycle.

const T_REF = new Date("2026-04-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const BOOT_SESSION_ID = "ses_runnerBootLifetime";

describe("Finding BD/BE/BF — HandlerKeyRegistry", () => {
  it("enroll + has + get", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({
      kid: "kid-1",
      spki_hex: "deadbeef",
      algo: "EdDSA",
      enrolled_at: T_REF.toISOString()
    });
    expect(reg.has("kid-1")).toBe(true);
    expect(reg.get("kid-1")?.spki_hex).toBe("deadbeef");
  });

  it("duplicate kid → HandlerKidConflict", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({ kid: "k", spki_hex: "", algo: "EdDSA", enrolled_at: T_REF.toISOString() });
    expect(() =>
      reg.enroll({ kid: "k", spki_hex: "", algo: "EdDSA", enrolled_at: T_REF.toISOString() })
    ).toThrow(HandlerKidConflict);
  });

  it("non-conforming algo → AlgorithmRejected", () => {
    const reg = new HandlerKeyRegistry();
    expect(() =>
      reg.enroll({
        kid: "k",
        spki_hex: "",
        algo: "RS256" as "EdDSA", // forced cast — simulates attacker input
        enrolled_at: T_REF.toISOString()
      })
    ).toThrow(AlgorithmRejected);
  });

  it("assertUsable OK within 90 days", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({ kid: "k", spki_hex: "", algo: "EdDSA", enrolled_at: T_REF.toISOString() });
    expect(() =>
      reg.assertUsable("k", new Date(T_REF.getTime() + 30 * DAY_MS))
    ).not.toThrow();
  });

  it("assertUsable > 90 days → HandlerKeyExpired with age_days", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({ kid: "k", spki_hex: "", algo: "EdDSA", enrolled_at: T_REF.toISOString() });
    try {
      reg.assertUsable("k", new Date(T_REF.getTime() + 91 * DAY_MS));
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HandlerKeyExpired);
      expect((err as HandlerKeyExpired).info.age_days).toBe(91);
      expect((err as HandlerKeyExpired).info.max_age_days).toBe(90);
    }
  });

  it("revoke + assertUsable → HandlerKeyRevoked (revocation beats age)", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({ kid: "k", spki_hex: "", algo: "EdDSA", enrolled_at: T_REF.toISOString() });
    reg.revoke("k", T_REF.toISOString(), "compromise");
    expect(() => reg.assertUsable("k", T_REF)).toThrow(HandlerKeyRevoked);
  });

  it("rotation overlap window suppresses age check", () => {
    const reg = new HandlerKeyRegistry();
    const enrolled = new Date(T_REF.getTime() - 91 * DAY_MS); // already aged
    const overlapEnd = new Date(T_REF.getTime() + 1 * DAY_MS); // window still open
    reg.enroll({
      kid: "k",
      spki_hex: "",
      algo: "EdDSA",
      enrolled_at: enrolled.toISOString(),
      rotation_overlap_end: overlapEnd.toISOString()
    });
    expect(() => reg.assertUsable("k", T_REF)).not.toThrow();
  });

  it("past overlap end → age check fires normally", () => {
    const reg = new HandlerKeyRegistry();
    const enrolled = new Date(T_REF.getTime() - 91 * DAY_MS);
    const overlapEnd = new Date(T_REF.getTime() - 1 * DAY_MS); // window closed
    reg.enroll({
      kid: "k",
      spki_hex: "",
      algo: "EdDSA",
      enrolled_at: enrolled.toISOString(),
      rotation_overlap_end: overlapEnd.toISOString()
    });
    expect(() => reg.assertUsable("k", T_REF)).toThrow(HandlerKeyExpired);
  });
});

describe("Finding BD/BE/BF — parseHandlerEnv + production guard", () => {
  it("no env → empty config, no throw on any host", () => {
    const cfg = parseHandlerEnv({});
    expect(cfg).toEqual({});
    expect(() => assertHandlerEnvListenerSafe({ env: cfg, host: "0.0.0.0" })).not.toThrow();
  });

  it("SOA_HANDLER_ENROLLED_AT set on loopback → safe", () => {
    const cfg = parseHandlerEnv({ SOA_HANDLER_ENROLLED_AT: T_REF.toISOString() });
    expect(cfg.enrolledAtOverride).toBe(T_REF.toISOString());
    expect(() => assertHandlerEnvListenerSafe({ env: cfg, host: "127.0.0.1" })).not.toThrow();
  });

  it("SOA_HANDLER_ENROLLED_AT set on non-loopback → HandlerEnvHookOnPublicListener", () => {
    const cfg = parseHandlerEnv({ SOA_HANDLER_ENROLLED_AT: T_REF.toISOString() });
    expect(() =>
      assertHandlerEnvListenerSafe({ env: cfg, host: "0.0.0.0" })
    ).toThrow(HandlerEnvHookOnPublicListener);
  });

  it("RUNNER_HANDLER_CRL_POLL_TICK_MS parses to integer", () => {
    const cfg = parseHandlerEnv({ RUNNER_HANDLER_CRL_POLL_TICK_MS: "250" });
    expect(cfg.crlPollTickMs).toBe(250);
  });
});

describe("Finding BD/BE/BF — overlap-dir loader", () => {
  it("loads two key manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "bd-overlap-"));
    try {
      const k1 = join(dir, "key-1");
      const k2 = join(dir, "key-2");
      mkdirSync(k1);
      mkdirSync(k2);
      writeFileSync(
        join(k1, "manifest.json"),
        JSON.stringify({
          kid: "k1",
          algo: "EdDSA",
          issued_at: "2026-04-20T00:00:00Z",
          rotation_overlap_end: "2026-04-23T00:00:00Z",
          spki: "aa11"
        })
      );
      writeFileSync(
        join(k2, "manifest.json"),
        JSON.stringify({
          kid: "k2",
          algo: "EdDSA",
          issued_at: "2026-04-22T00:00:00Z",
          rotation_overlap_end: "2026-04-26T00:00:00Z",
          spki: "bb22"
        })
      );
      const entries = loadOverlapKeypairs(dir);
      expect(entries.length).toBe(2);
      const kids = new Set(entries.map((e) => e.kid));
      expect(kids.has("k1")).toBe(true);
      expect(kids.has("k2")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("both kids verify inside overlap window 2026-04-22 → 2026-04-23", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({
      kid: "k1",
      spki_hex: "",
      algo: "EdDSA",
      enrolled_at: "2026-04-20T00:00:00Z",
      rotation_overlap_end: "2026-04-23T00:00:00Z"
    });
    reg.enroll({
      kid: "k2",
      spki_hex: "",
      algo: "EdDSA",
      enrolled_at: "2026-04-22T00:00:00Z",
      rotation_overlap_end: "2026-04-26T00:00:00Z"
    });
    // Inside the 2026-04-22 → 2026-04-23 window both kids accept.
    const inWindow = new Date("2026-04-22T12:00:00Z");
    expect(() => reg.assertUsable("k1", inWindow)).not.toThrow();
    expect(() => reg.assertUsable("k2", inWindow)).not.toThrow();
  });
});

describe("Finding BD/BE/BF — HandlerCrlPoller", () => {
  it("tick with no revocation file → emits crl-refresh-complete log record only", () => {
    const reg = new HandlerKeyRegistry();
    const sys = new SystemLogBuffer({ clock: () => T_REF });
    const dir = mkdtempSync(join(tmpdir(), "bd-crl-"));
    try {
      const poller = new HandlerCrlPoller({
        filePath: join(dir, "nonexistent.json"),
        registry: reg,
        tickMs: 100,
        clock: () => T_REF,
        systemLog: sys,
        bootSessionId: BOOT_SESSION_ID,
        setInterval: () => null as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined
      });
      poller.tick();
      const snap = sys.snapshot(BOOT_SESSION_ID);
      expect(snap.length).toBe(1);
      expect(snap[0]?.category).toBe("Config");
      expect(snap[0]?.level).toBe("info");
      expect(snap[0]?.code).toBe("crl-refresh-complete");
      expect(snap[0]?.data?.["last_crl_refresh_at"]).toBe(T_REF.toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BE-ext: poller with NO filePath still emits crl-refresh-complete each tick (SV-PERM-14)", () => {
    const reg = new HandlerKeyRegistry();
    const sys = new SystemLogBuffer({ clock: () => T_REF });
    const poller = new HandlerCrlPoller({
      // No filePath at all.
      registry: reg,
      tickMs: 100,
      clock: () => T_REF,
      systemLog: sys,
      bootSessionId: BOOT_SESSION_ID,
      setInterval: () => null as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined
    });
    poller.tick();
    poller.tick();
    const snap = sys.snapshot(BOOT_SESSION_ID);
    expect(snap.length).toBe(2);
    expect(snap[0]?.code).toBe("crl-refresh-complete");
    expect(snap[1]?.code).toBe("crl-refresh-complete");
    expect(snap[0]?.data?.["revoked_count"]).toBe(0);
  });

  it("handler_kid entry in file → revokes registry + fires onHandlerRevoked", () => {
    const reg = new HandlerKeyRegistry();
    reg.enroll({
      kid: "handler-evil",
      spki_hex: "",
      algo: "EdDSA",
      enrolled_at: T_REF.toISOString()
    });
    const sys = new SystemLogBuffer({ clock: () => T_REF });
    const dir = mkdtempSync(join(tmpdir(), "bd-crl-"));
    const filePath = join(dir, "revoked.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        handler_kid: "handler-evil",
        reason: "compromise",
        revoked_at: "2026-04-22T12:00:00Z"
      })
    );
    try {
      let seenKid: string | null = null;
      const poller = new HandlerCrlPoller({
        filePath,
        registry: reg,
        tickMs: 100,
        clock: () => T_REF,
        systemLog: sys,
        bootSessionId: BOOT_SESSION_ID,
        onHandlerRevoked: (kid) => {
          seenKid = kid;
        },
        setInterval: () => null as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined
      });
      poller.tick();
      expect(seenKid).toBe("handler-evil");
      expect(reg.isRevoked("handler-evil")).toBe(true);
      const snap = sys.snapshot(BOOT_SESSION_ID);
      expect(snap[0]?.data?.["revoked_count"]).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publisher_kid entry → ignored by handler poller (non-matching field)", () => {
    const reg = new HandlerKeyRegistry();
    const sys = new SystemLogBuffer({ clock: () => T_REF });
    const dir = mkdtempSync(join(tmpdir(), "bd-crl-"));
    const filePath = join(dir, "revoked.json");
    writeFileSync(
      filePath,
      JSON.stringify({ publisher_kid: "pub-1", reason: "administrative" })
    );
    try {
      const poller = new HandlerCrlPoller({
        filePath,
        registry: reg,
        tickMs: 100,
        clock: () => T_REF,
        systemLog: sys,
        bootSessionId: BOOT_SESSION_ID,
        setInterval: () => null as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined
      });
      poller.tick();
      // No revocation recorded; refresh row still emitted.
      expect(sys.snapshot(BOOT_SESSION_ID)[0]?.data?.["revoked_count"]).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
