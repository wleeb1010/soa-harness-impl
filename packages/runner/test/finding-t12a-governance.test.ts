import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fastify } from "fastify";
import {
  versionPlugin,
  negotiateCoreVersion,
  parseSupportedCoreVersions,
  RUNNER_SUPPORTED_CORE_VERSIONS,
  RUNNER_SOA_HARNESS_VERSION
} from "../src/governance/index.js";
import {
  sessionsBootstrapPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";

// T-12a SV-GOV block:
// - SV-GOV-01: soaHarnessVersion advertised in Card
// - SV-GOV-02: docs/stability-tiers.md present
// - SV-GOV-03: docs/migrations/ present
// - SV-GOV-04: deprecation lifetime ≥ 2 minors (trivial at v1.0)
// - SV-GOV-05: errata URL reachable (/errata/v1.0.json → 200 JSON)
// - SV-GOV-06: validator-side (impl action: none)
// - SV-GOV-07: normative references pinned (spec/impl action: none here)
// - SV-GOV-08: version negotiation empty-intersection → VersionNegotiationFailed
// - SV-GOV-11: release-gate.json with 5 checks

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe("T-12a SV-GOV-02 — docs/stability-tiers.md", () => {
  it("file exists and declares at least one Stable field", () => {
    const p = resolve(REPO_ROOT, "docs", "stability-tiers.md");
    expect(existsSync(p), `expected ${p} to exist`).toBe(true);
    const body = readFileSync(p, "utf8");
    expect(body).toMatch(/soaHarnessVersion/);
    expect(body).toMatch(/Stable/);
    expect(body).toMatch(/§19\.3/);
  });
});

describe("T-12a SV-GOV-03 — migrations directory", () => {
  it("docs/migrations/README.md exists with §19.4 linkage", () => {
    const p = resolve(REPO_ROOT, "docs", "migrations", "README.md");
    expect(existsSync(p), `expected ${p} to exist`).toBe(true);
    const body = readFileSync(p, "utf8");
    expect(body).toMatch(/§19\.4/);
    expect(body).toMatch(/migrations/);
  });
});

describe("T-12a SV-GOV-05 — errata endpoint", () => {
  it("docs/errata-v1.0.json is valid JSON with at least one erratum entry", () => {
    const p = resolve(REPO_ROOT, "docs", "errata-v1.0.json");
    expect(existsSync(p), `expected ${p} to exist`).toBe(true);
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(body.spec_version).toBe("1.0");
    expect(Array.isArray(body.errata)).toBe(true);
    expect(body.errata.length).toBeGreaterThan(0);
    for (const e of body.errata) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.section).toBe("string");
      expect(typeof e.body).toBe("string");
    }
  });

  it("GET /errata/v1.0.json returns 200 JSON with the body we injected", async () => {
    const app = fastify();
    const errataBody = { spec_version: "1.0", errata: [{ id: "E-001", section: "§1", body: "x" }] };
    await app.register(versionPlugin, {
      readiness: { check: () => null },
      clock: () => new Date("2026-04-22T15:00:00.000Z"),
      errataBody
    });
    try {
      const res = await app.inject({ method: "GET", url: "/errata/v1.0.json" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      const body = JSON.parse(res.body);
      expect(body.spec_version).toBe("1.0");
      expect(body.errata[0].id).toBe("E-001");
    } finally {
      await app.close();
    }
  });

  it("GET /errata/v1.0.json returns 404 when no body is wired", async () => {
    const app = fastify();
    await app.register(versionPlugin, {
      readiness: { check: () => null },
      clock: () => new Date("2026-04-22T15:00:00.000Z")
    });
    try {
      const res = await app.inject({ method: "GET", url: "/errata/v1.0.json" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("T-12a SV-GOV-11 — release-gate.json", () => {
  it("release-gate.json exists at repo root with 5 passing checks", () => {
    const p = resolve(REPO_ROOT, "release-gate.json");
    expect(existsSync(p), `expected ${p} to exist`).toBe(true);
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBe(5);
    const ids = body.checks.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([
      "manifest-regeneration-parity",
      "must-map-zero-orphan",
      "schema-2020-12-lint",
      "schema-extraction-parity",
      "test-vector-digest-parity"
    ]);
    expect(body.summary.total).toBe(5);
    expect(body.summary.pass).toBe(5);
    expect(body.summary.fail).toBe(0);
    expect(body.signed_manifest_eligible).toBe(true);
  });
});

describe("T-12a SV-GOV-08 — version negotiation primitives", () => {
  it("negotiateCoreVersion: non-empty intersection → highest common", () => {
    expect(negotiateCoreVersion(["1.0"], ["1.0"])).toBe("1.0");
    expect(negotiateCoreVersion(["1.0", "1.1", "1.2"], ["1.0", "1.1"])).toBe("1.1");
    // Tuple comparison, not string compare: 1.10 > 1.2.
    expect(negotiateCoreVersion(["1.10", "1.2"], ["1.10", "1.2"])).toBe("1.10");
  });

  it("negotiateCoreVersion: empty intersection → null", () => {
    expect(negotiateCoreVersion(["2.0"], ["1.0"])).toBe(null);
    expect(negotiateCoreVersion(["0.9"], ["1.0"])).toBe(null);
    expect(negotiateCoreVersion([], ["1.0"])).toBe(null);
  });

  it("parseSupportedCoreVersions: valid array → returns array", () => {
    expect(parseSupportedCoreVersions(["1.0", "1.1"])).toEqual(["1.0", "1.1"]);
  });

  it("parseSupportedCoreVersions: invalid inputs → error", () => {
    const notArray = parseSupportedCoreVersions("1.0");
    expect(!Array.isArray(notArray) && typeof notArray.error).toBe("string");
    const empty = parseSupportedCoreVersions([]);
    expect(!Array.isArray(empty) && typeof empty.error).toBe("string");
    const bad = parseSupportedCoreVersions(["1.x"]);
    expect(!Array.isArray(bad) && typeof bad.error).toBe("string");
    const dup = parseSupportedCoreVersions(["1.0", "1.0"]);
    expect(!Array.isArray(dup) && typeof dup.error).toBe("string");
  });

  it("Runner's advertised set is [\"1.0\"] and soaHarnessVersion is \"1.0\"", () => {
    expect(RUNNER_SUPPORTED_CORE_VERSIONS).toEqual(["1.0"]);
    expect(RUNNER_SOA_HARNESS_VERSION).toBe("1.0");
  });

  it("GET /version returns runner's supported set", async () => {
    const app = fastify();
    const FROZEN = new Date("2026-04-22T15:00:00.000Z");
    await app.register(versionPlugin, {
      readiness: { check: () => null },
      clock: () => FROZEN,
      runnerVersion: "1.0"
    });
    try {
      const res = await app.inject({ method: "GET", url: "/version" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.soaHarnessVersion).toBe("1.0");
      expect(body.supported_core_versions).toEqual(["1.0"]);
      expect(body.runner_version).toBe("1.0");
      expect(body.generated_at).toBe(FROZEN.toISOString());
    } finally {
      await app.close();
    }
  });

  it("GET /version honors injected supportedCoreVersions", async () => {
    const app = fastify();
    await app.register(versionPlugin, {
      readiness: { check: () => null },
      clock: () => new Date("2026-04-22T15:00:00.000Z"),
      supportedCoreVersions: ["1.0", "1.1"]
    });
    try {
      const res = await app.inject({ method: "GET", url: "/version" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.supported_core_versions).toEqual(["1.0", "1.1"]);
    } finally {
      await app.close();
    }
  });
});

describe("T-12a SV-GOV-08 — POST /sessions version-negotiation gate", () => {
  const FROZEN = new Date("2026-04-22T15:00:00.000Z");
  const BOOTSTRAP_BEARER = "gov-bootstrap";

  async function buildApp(opts: { runnerSupported?: readonly string[] } = {}) {
    const app = fastify();
    const store = new InMemorySessionStore();
    await app.register(sessionsBootstrapPlugin, {
      sessionStore: store,
      readiness: { check: () => null },
      clock: () => FROZEN,
      cardActiveMode: "WorkspaceWrite",
      bootstrapBearer: BOOTSTRAP_BEARER,
      ...(opts.runnerSupported !== undefined ? { supportedCoreVersions: opts.runnerSupported } : {})
    });
    return app;
  }

  it("caller omits supported_core_versions → 201 (implicit accept)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: { requested_activeMode: "ReadOnly", user_sub: "alice" }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("caller advertises intersecting set → 201", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "alice",
          supported_core_versions: ["0.9", "1.0", "1.1"]
        }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("caller advertises empty-intersection set → 400 VersionNegotiationFailed", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "alice",
          supported_core_versions: ["2.0", "2.1"]
        }
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("VersionNegotiationFailed");
      expect(body.runner_supported_core_versions).toEqual(["1.0"]);
      expect(body.caller_supported_core_versions).toEqual(["2.0", "2.1"]);
      expect(body.detail).toMatch(/intersection is empty/);
    } finally {
      await app.close();
    }
  });

  it("caller supplies malformed supported_core_versions → 400 malformed-request", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: {
          requested_activeMode: "ReadOnly",
          user_sub: "alice",
          supported_core_versions: ["1.x"]
        }
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("malformed-request");
      expect(body.detail).toMatch(/supported_core_versions/);
    } finally {
      await app.close();
    }
  });

  it("negotiation gate fires BEFORE capability gate (not after)", async () => {
    const app = await buildApp();
    try {
      // cardActiveMode=WorkspaceWrite → ReadOnly is allowed. If the
      // negotiation gate were placed AFTER the capability check, an
      // empty-intersection request with a valid activeMode would still
      // succeed. The spec is clear that negotiation is the session-
      // establishment precondition, so we verify ordering here.
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: `Bearer ${BOOTSTRAP_BEARER}`, "content-type": "application/json" },
        payload: {
          requested_activeMode: "DangerFullAccess", // looser than card — would 403
          user_sub: "alice",
          supported_core_versions: ["2.0"] // empty intersection — should 400 FIRST
        }
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("VersionNegotiationFailed");
    } finally {
      await app.close();
    }
  });
});

describe("T-12a SV-GOV-01 — soaHarnessVersion in Card fixtures", () => {
  it("test-runner-agent fixture declares soaHarnessVersion=\"1.0\"", () => {
    const fixturePath = resolve(
      __dirname,
      "fixtures",
      "agent-card.sample.json"
    );
    const body = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(body.soaHarnessVersion).toBe("1.0");
  });

  it("demo-agent template declares soaHarnessVersion=\"1.0\"", () => {
    const templatePath = resolve(
      REPO_ROOT,
      "packages",
      "create-soa-agent",
      "templates",
      "runner-starter",
      "agent-card.json"
    );
    const body = JSON.parse(readFileSync(templatePath, "utf8"));
    expect(body.soaHarnessVersion).toBe("1.0");
  });
});
