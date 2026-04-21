import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadInitialTrust, HostHardeningInsufficient } from "../src/bootstrap/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const VALID_FIXTURE = readFileSync(join(here, "fixtures", "initial-trust.valid.json"), "utf8");
const VALID_TRUST = JSON.parse(VALID_FIXTURE) as Record<string, unknown>;

function withTempTrust(body: string | Buffer): { path: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "soa-trust-"));
  const path = join(dir, "initial-trust.json");
  writeFileSync(path, body);
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadInitialTrust", () => {
  let good: { path: string; dispose(): void };

  beforeAll(() => {
    good = withTempTrust(VALID_FIXTURE);
  });

  afterAll(() => {
    good.dispose();
  });

  it("loads the valid fixture and returns the parsed trust root", () => {
    const trust = loadInitialTrust({ path: good.path });
    expect(trust.soaHarnessVersion).toBe("1.0");
    expect(trust.publisher_kid).toBe("soa-release-v1.0");
    expect(trust.channel).toBe("sdk-pinned");
  });

  it("fails with bootstrap-missing when the file is absent", () => {
    try {
      loadInitialTrust({ path: join(tmpdir(), "does-not-exist-xyz.json") });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-missing");
      return;
    }
    throw new Error("expected HostHardeningInsufficient");
  });

  it("fails with bootstrap-malformed when JSON is invalid", () => {
    const bad = withTempTrust("{not json");
    try {
      loadInitialTrust({ path: bad.path });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-malformed");
    } finally {
      bad.dispose();
    }
  });

  it("rejects a UTF-8 BOM prefix", () => {
    const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID_FIXTURE, "utf8")]);
    const bad = withTempTrust(bomBuf);
    try {
      loadInitialTrust({ path: bad.path });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-malformed");
    } finally {
      bad.dispose();
    }
  });

  it("fails with bootstrap-invalid-schema when a required field is missing", () => {
    const missing = { ...VALID_TRUST };
    delete (missing as Record<string, unknown>).publisher_kid;
    const bad = withTempTrust(JSON.stringify(missing));
    try {
      loadInitialTrust({ path: bad.path });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-invalid-schema");
    } finally {
      bad.dispose();
    }
  });

  it("fails with bootstrap-expired when not_after has passed", () => {
    const expired = { ...VALID_TRUST, not_after: "2020-01-01T00:00:00Z" };
    const bad = withTempTrust(JSON.stringify(expired));
    try {
      loadInitialTrust({ path: bad.path });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-expired");
    } finally {
      bad.dispose();
    }
  });

  it("fails with bootstrap-channel-unsupported when expectedChannel is pinned and mismatches", () => {
    const other = { ...VALID_TRUST, channel: "operator-bundled" };
    const bad = withTempTrust(JSON.stringify(other));
    try {
      loadInitialTrust({ path: bad.path, expectedChannel: "sdk-pinned" });
    } catch (err) {
      expect(err).toBeInstanceOf(HostHardeningInsufficient);
      expect((err as HostHardeningInsufficient).reason).toBe("bootstrap-channel-unsupported");
      return;
    } finally {
      bad.dispose();
    }
    throw new Error("expected HostHardeningInsufficient");
  });

  it("accepts a trust file without a channel field (defaults to expected)", () => {
    const noChannel = { ...VALID_TRUST };
    delete (noChannel as Record<string, unknown>).channel;
    const ok = withTempTrust(JSON.stringify(noChannel));
    try {
      const trust = loadInitialTrust({ path: ok.path });
      expect(trust.channel).toBeUndefined();
    } finally {
      ok.dispose();
    }
  });
});
