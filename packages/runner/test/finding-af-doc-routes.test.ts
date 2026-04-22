import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import { versionPlugin, type DocRoute } from "../src/governance/index.js";

// Finding AF — HTTP doc routes. Validator probes docs/ artifacts over
// HTTP instead of filesystem read; this test asserts the governance
// plugin surfaces each configured route with the right Content-Type +
// exact body bytes.

const FROZEN = new Date("2026-04-22T15:00:00.000Z");

async function buildApp(docRoutes: readonly DocRoute[]) {
  const app = fastify();
  await app.register(versionPlugin, {
    readiness: { check: () => null },
    clock: () => FROZEN,
    docRoutes
  });
  return app;
}

describe("Finding AF — HTTP doc routes", () => {
  it("serves a markdown body with text/markdown content-type", async () => {
    const body = "# hello\n\nsoaHarnessVersion = 1.0\n";
    const app = await buildApp([
      {
        route: "/docs/stability-tiers.md",
        body,
        contentType: "text/markdown; charset=utf-8"
      }
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/docs/stability-tiers.md" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
      expect(res.body).toBe(body);
    } finally {
      await app.close();
    }
  });

  it("serves a JSON body with application/json content-type", async () => {
    const body = JSON.stringify({ spec_version: "1.0", checks: [] });
    const app = await buildApp([
      {
        route: "/release-gate.json",
        body,
        contentType: "application/json; charset=utf-8"
      }
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/release-gate.json" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).toBe(body);
    } finally {
      await app.close();
    }
  });

  it("honors custom Cache-Control per route", async () => {
    const body = "x";
    const app = await buildApp([
      {
        route: "/docs/static.md",
        body,
        contentType: "text/markdown",
        cacheControl: "public, max-age=86400"
      }
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/docs/static.md" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    } finally {
      await app.close();
    }
  });

  it("default Cache-Control is max-age=300 when not set", async () => {
    const app = await buildApp([
      { route: "/docs/x.md", body: "x", contentType: "text/markdown" }
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/docs/x.md" });
      expect(res.headers["cache-control"]).toBe("max-age=300");
    } finally {
      await app.close();
    }
  });

  it("multiple routes can coexist in one plugin registration", async () => {
    const app = await buildApp([
      { route: "/docs/data-inventory.md", body: "di", contentType: "text/markdown" },
      { route: "/docs/stability-tiers.md", body: "st", contentType: "text/markdown" },
      { route: "/docs/migrations/README.md", body: "mg", contentType: "text/markdown" },
      { route: "/docs/errata-v1.0.json", body: "{\"e\":1}", contentType: "application/json" },
      { route: "/release-gate.json", body: "{\"g\":1}", contentType: "application/json" }
    ]);
    try {
      const urls = [
        "/docs/data-inventory.md",
        "/docs/stability-tiers.md",
        "/docs/migrations/README.md",
        "/docs/errata-v1.0.json",
        "/release-gate.json"
      ];
      const bodies = ["di", "st", "mg", "{\"e\":1}", "{\"g\":1}"];
      for (let i = 0; i < urls.length; i++) {
        const res = await app.inject({ method: "GET", url: urls[i]! });
        expect(res.statusCode, `route ${urls[i]}`).toBe(200);
        expect(res.body, `body ${urls[i]}`).toBe(bodies[i]);
      }
    } finally {
      await app.close();
    }
  });

  it("empty docRoutes array does not register any routes", async () => {
    const app = await buildApp([]);
    try {
      const res = await app.inject({ method: "GET", url: "/docs/data-inventory.md" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("/version keeps working alongside doc routes", async () => {
    const app = await buildApp([
      { route: "/docs/y.md", body: "y", contentType: "text/markdown" }
    ]);
    try {
      const res = await app.inject({ method: "GET", url: "/version" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.soaHarnessVersion).toBe("1.0");
    } finally {
      await app.close();
    }
  });
});
