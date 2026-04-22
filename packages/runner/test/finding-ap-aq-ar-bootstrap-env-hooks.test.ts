import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBootstrapEnv,
  assertBootstrapEnvHooksListenerSafe,
  BootstrapHookOnPublicListener,
  loadDnssecBootstrap,
  parseDnssecTxtRecord,
  detectSplitBrain,
  RevocationPoller,
  HostHardeningInsufficient,
  type InitialTrust
} from "../src/bootstrap/index.js";

// §5.3.3 Findings AP/AQ/AR — bootstrap env-hook parsers + guards +
// DNSSEC loader + revocation poller + split-brain detector.

function scratch(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "boot-hooks-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("§5.3.3 — parseBootstrapEnv + production guard", () => {
  it("all four env vars unset → empty config", () => {
    expect(parseBootstrapEnv({})).toEqual({});
  });

  it("SOA_BOOTSTRAP_DNSSEC_TXT is recognized", () => {
    expect(parseBootstrapEnv({ SOA_BOOTSTRAP_DNSSEC_TXT: "/fx.json" })).toEqual({
      dnssecTxtPath: "/fx.json"
    });
  });

  it("RUNNER_BOOTSTRAP_POLL_TICK_MS integer → pollTickMs", () => {
    expect(parseBootstrapEnv({ RUNNER_BOOTSTRAP_POLL_TICK_MS: "100" })).toEqual({
      pollTickMs: 100
    });
  });

  it("RUNNER_BOOTSTRAP_POLL_TICK_MS non-integer → throws", () => {
    expect(() =>
      parseBootstrapEnv({ RUNNER_BOOTSTRAP_POLL_TICK_MS: "not-a-number" })
    ).toThrow(/positive integer/);
    expect(() => parseBootstrapEnv({ RUNNER_BOOTSTRAP_POLL_TICK_MS: "0" })).toThrow(
      /positive integer/
    );
  });

  it("SOA_BOOTSTRAP_REVOCATION_FILE + SECONDARY_CHANNEL pass through", () => {
    expect(
      parseBootstrapEnv({
        SOA_BOOTSTRAP_REVOCATION_FILE: "/rev.json",
        SOA_BOOTSTRAP_SECONDARY_CHANNEL: "/sec.json"
      })
    ).toEqual({
      revocationFilePath: "/rev.json",
      secondaryChannelPath: "/sec.json"
    });
  });

  it("guard is inert when no env set, regardless of host", () => {
    expect(() =>
      assertBootstrapEnvHooksListenerSafe({ env: {}, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("guard allows loopback hosts when env set", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(() =>
        assertBootstrapEnvHooksListenerSafe({
          env: { dnssecTxtPath: "/fx" },
          host
        })
      ).not.toThrow();
    }
  });

  it("guard refuses non-loopback when any env set", () => {
    expect(() =>
      assertBootstrapEnvHooksListenerSafe({
        env: { dnssecTxtPath: "/fx" },
        host: "0.0.0.0"
      })
    ).toThrow(BootstrapHookOnPublicListener);
    expect(() =>
      assertBootstrapEnvHooksListenerSafe({
        env: { secondaryChannelPath: "/sec" },
        host: "192.168.1.5"
      })
    ).toThrow(BootstrapHookOnPublicListener);
  });
});

describe("Finding AP — DNSSEC fixture loader", () => {
  it("parseDnssecTxtRecord splits canonical TXT into fields", () => {
    const out = parseDnssecTxtRecord(
      'publisher_kid=soa-release-v1.0; spki_sha256=abcd; issuer="CN=Example CA"'
    );
    expect(out).toEqual({
      publisher_kid: "soa-release-v1.0",
      spki_sha256: "abcd",
      issuer: "CN=Example CA"
    });
  });

  it("valid fixture → returns InitialTrust with channel=dnssec-txt", () => {
    const s = scratch();
    try {
      const path = join(s.dir, "valid.json");
      writeFileSync(
        path,
        JSON.stringify({
          txt_record:
            'publisher_kid=soa-release-v1.0; spki_sha256=abcd; issuer="CN=Test"',
          ad_bit: true,
          empty: false
        })
      );
      const trust = loadDnssecBootstrap({ path });
      expect(trust.publisher_kid).toBe("soa-release-v1.0");
      expect(trust.spki_sha256).toBe("abcd");
      expect(trust.channel).toBe("dnssec-txt");
    } finally {
      s.dispose();
    }
  });

  it("empty=true → HostHardeningInsufficient(bootstrap-missing)", () => {
    const s = scratch();
    try {
      const path = join(s.dir, "empty.json");
      writeFileSync(path, JSON.stringify({ txt_record: "", ad_bit: false, empty: true }));
      expect(() => loadDnssecBootstrap({ path })).toThrowError(HostHardeningInsufficient);
      try {
        loadDnssecBootstrap({ path });
      } catch (err) {
        expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-missing");
        expect((err as HostHardeningInsufficient).message).toMatch(/empty/);
      }
    } finally {
      s.dispose();
    }
  });

  it("ad_bit=false → HostHardeningInsufficient(bootstrap-missing)", () => {
    const s = scratch();
    try {
      const path = join(s.dir, "missing-ad-bit.json");
      writeFileSync(
        path,
        JSON.stringify({
          txt_record:
            'publisher_kid=soa-release-v1.0; spki_sha256=abcd; issuer="CN=Test"',
          ad_bit: false,
          empty: false
        })
      );
      try {
        loadDnssecBootstrap({ path });
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HostHardeningInsufficient);
        expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-missing");
        expect((err as HostHardeningInsufficient).message).toMatch(/AD.*bit/);
      }
    } finally {
      s.dispose();
    }
  });

  it("expectedPublisherKid mismatch → throws bootstrap-missing", () => {
    const s = scratch();
    try {
      const path = join(s.dir, "valid.json");
      writeFileSync(
        path,
        JSON.stringify({
          txt_record:
            'publisher_kid=soa-A; spki_sha256=abcd; issuer="CN=Test"',
          ad_bit: true,
          empty: false
        })
      );
      expect(() =>
        loadDnssecBootstrap({ path, expectedPublisherKid: "soa-B" })
      ).toThrowError(HostHardeningInsufficient);
    } finally {
      s.dispose();
    }
  });

  it("non-existent fixture path → bootstrap-missing", () => {
    expect(() => loadDnssecBootstrap({ path: "/no/such/path.json" })).toThrowError(
      HostHardeningInsufficient
    );
  });
});

describe("Finding AQ — revocation poller", () => {
  const FAKE_TRUST_KID = "soa-target-v1.0";

  it("no file present → no onRevoked call", () => {
    const s = scratch();
    try {
      const revPath = join(s.dir, "rev.json");
      let fired = 0;
      const poller = new RevocationPoller({
        filePath: revPath,
        expectedPublisherKid: FAKE_TRUST_KID,
        tickMs: 10_000,
        onRevoked: () => {
          fired++;
        }
      });
      poller.tick();
      poller.tick();
      expect(fired).toBe(0);
      expect(poller.isRevoked()).toBe(false);
    } finally {
      s.dispose();
    }
  });

  it("file with matching publisher_kid → fires once + terminal", () => {
    const s = scratch();
    try {
      const revPath = join(s.dir, "rev.json");
      let fired = 0;
      let capturedReason: string | undefined;
      const poller = new RevocationPoller({
        filePath: revPath,
        expectedPublisherKid: FAKE_TRUST_KID,
        tickMs: 10_000,
        onRevoked: (rec) => {
          fired++;
          capturedReason = rec.reason;
        }
      });
      writeFileSync(
        revPath,
        JSON.stringify({ publisher_kid: FAKE_TRUST_KID, reason: "compromise" })
      );
      poller.tick();
      expect(fired).toBe(1);
      expect(capturedReason).toBe("compromise");
      expect(poller.isRevoked()).toBe(true);
      // Subsequent ticks don't fire — terminal state.
      poller.tick();
      poller.tick();
      expect(fired).toBe(1);
    } finally {
      s.dispose();
    }
  });

  it("file with mismatched publisher_kid is ignored", () => {
    const s = scratch();
    try {
      const revPath = join(s.dir, "rev.json");
      let fired = 0;
      const poller = new RevocationPoller({
        filePath: revPath,
        expectedPublisherKid: FAKE_TRUST_KID,
        tickMs: 10_000,
        onRevoked: () => {
          fired++;
        }
      });
      writeFileSync(
        revPath,
        JSON.stringify({ publisher_kid: "soa-different-v1.0", reason: "compromise" })
      );
      poller.tick();
      expect(fired).toBe(0);
      expect(poller.isRevoked()).toBe(false);
    } finally {
      s.dispose();
    }
  });

  it("malformed JSON in revocation file is logged but non-fatal", () => {
    const s = scratch();
    try {
      const revPath = join(s.dir, "rev.json");
      let fired = 0;
      const logs: string[] = [];
      const poller = new RevocationPoller({
        filePath: revPath,
        expectedPublisherKid: FAKE_TRUST_KID,
        tickMs: 10_000,
        onRevoked: () => {
          fired++;
        },
        log: (m) => logs.push(m)
      });
      writeFileSync(revPath, "{this is not json");
      poller.tick();
      expect(fired).toBe(0);
      expect(logs.some((m) => /failed to parse/.test(m))).toBe(true);
    } finally {
      s.dispose();
    }
  });

  it("start()/stop() are idempotent", () => {
    const s = scratch();
    try {
      const revPath = join(s.dir, "rev.json");
      const poller = new RevocationPoller({
        filePath: revPath,
        expectedPublisherKid: FAKE_TRUST_KID,
        tickMs: 10_000,
        onRevoked: () => undefined,
        setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
        clearInterval: (() => undefined) as unknown as typeof clearInterval
      });
      poller.start();
      poller.start();
      poller.stop();
      poller.stop();
      expect(poller.isRevoked()).toBe(false);
    } finally {
      s.dispose();
    }
  });
});

describe("Finding AR — split-brain detector", () => {
  const authoritative: InitialTrust = {
    soaHarnessVersion: "1.0",
    publisher_kid: "soa-auth-v1.0",
    spki_sha256: "a".repeat(64),
    issuer: "CN=Authoritative",
    channel: "operator-bundled"
  };

  it("identical secondary → no throw (rule 3 agreement)", () => {
    const s = scratch();
    try {
      const p = join(s.dir, "sec.json");
      writeFileSync(
        p,
        JSON.stringify({
          publisher_kid: authoritative.publisher_kid,
          spki_sha256: authoritative.spki_sha256,
          issuer: authoritative.issuer
        })
      );
      expect(() =>
        detectSplitBrain({
          authoritative,
          secondaryPath: p,
          authoritativeChannel: "operator-bundled"
        })
      ).not.toThrow();
    } finally {
      s.dispose();
    }
  });

  it("dissenting publisher_kid → HostHardeningInsufficient(bootstrap-split-brain)", () => {
    const s = scratch();
    try {
      const p = join(s.dir, "sec.json");
      writeFileSync(
        p,
        JSON.stringify({
          publisher_kid: "soa-dissenting-channel-v1.0",
          spki_sha256: "f".repeat(64),
          issuer: "CN=Dissenting"
        })
      );
      try {
        detectSplitBrain({
          authoritative,
          secondaryPath: p,
          authoritativeChannel: "operator-bundled"
        });
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HostHardeningInsufficient);
        expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-split-brain");
      }
    } finally {
      s.dispose();
    }
  });

  it("successor_publisher_kid match is rotation-overlap (rule 4)", () => {
    const s = scratch();
    try {
      const p = join(s.dir, "sec.json");
      writeFileSync(
        p,
        JSON.stringify({
          publisher_kid: "soa-auth-v1.1",
          spki_sha256: "b".repeat(64),
          issuer: "CN=Successor"
        })
      );
      expect(() =>
        detectSplitBrain({
          authoritative: { ...authoritative, successor_publisher_kid: "soa-auth-v1.1" },
          secondaryPath: p,
          authoritativeChannel: "operator-bundled"
        })
      ).not.toThrow();
    } finally {
      s.dispose();
    }
  });

  it("secondary fixture missing → bootstrap-missing", () => {
    try {
      detectSplitBrain({
        authoritative,
        secondaryPath: "/no/such/secondary.json",
        authoritativeChannel: "operator-bundled"
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-missing");
    }
  });
});
