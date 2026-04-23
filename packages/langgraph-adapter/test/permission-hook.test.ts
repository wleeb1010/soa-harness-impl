/**
 * Runner-backed permission-hook tests — Phase 2 module A.
 *
 * Covers the HTTP round-trip semantics: allow on 201+AutoAllow, deny on
 * every failure mode (Prompt response, 4xx, 5xx, malformed body, abort,
 * network error, empty bearer, failed bearer provider). Uses a mock
 * fetch implementation — no real server needed.
 */

import { describe, it, expect } from "vitest";
import { RunnerBackedPermissionHook, createRunnerBackedPermissionHook } from "../src/permission-hook.js";

type FetchArgs = Parameters<typeof fetch>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (...args: FetchArgs) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RunnerBackedPermissionHook — HTTP decision round-trip", () => {
  it("AutoAllow response → decide() returns \"allow\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "bearer-abc",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "AutoAllow" })),
    });
    expect(await hook.decide("echo", { input: "hi" })).toBe("allow");
  });

  it("Prompt response (HITL needed, not wired in Phase 2) → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "Prompt" })),
    });
    expect(await hook.decide("risky", {})).toBe("deny");
  });

  it("Deny response → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "Deny" })),
    });
    expect(await hook.decide("forbidden", {})).toBe("deny");
  });

  it("CapabilityDenied / ConfigPrecedenceViolation → \"deny\"", async () => {
    for (const decision of ["CapabilityDenied", "ConfigPrecedenceViolation"]) {
      const hook = new RunnerBackedPermissionHook({
        runnerBaseUrl: "http://localhost:7700",
        bearer: "b",
        sessionId: "ses_1",
        fetchImpl: mockFetch(() => jsonResponse(201, { decision })),
      });
      expect(await hook.decide("t", {})).toBe("deny");
    }
  });

  it("4xx response → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(403, { error: "PermissionDenied" })),
    });
    expect(await hook.decide("t", {})).toBe("deny");
  });

  it("5xx response → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(503, { error: "not-ready" })),
    });
    expect(await hook.decide("t", {})).toBe("deny");
  });

  it("malformed JSON body → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(
        () => new Response("<html>not json</html>", { status: 201 }),
      ),
    });
    expect(await hook.decide("t", {})).toBe("deny");
  });

  it("network error (fetch throws) → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(await hook.decide("t", {})).toBe("deny");
  });

  it("request timeout (slow Runner) → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      timeoutMs: 50,
      fetchImpl: mockFetch(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    expect(await hook.decide("slow", {})).toBe("deny");
  });

  it("empty bearer → \"deny\" without making a request", async () => {
    let fetchCalled = false;
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => {
        fetchCalled = true;
        return jsonResponse(201, { decision: "AutoAllow" });
      }),
    });
    expect(await hook.decide("t", {})).toBe("deny");
    expect(fetchCalled).toBe(false);
  });

  it("bearer provider function is called per-request", async () => {
    let calls = 0;
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: async () => {
        calls += 1;
        return `bearer-${calls}`;
      },
      sessionId: "ses_1",
      fetchImpl: mockFetch((_url, init) => {
        const auth = (init.headers as Record<string, string>)["authorization"];
        expect(auth).toMatch(/^Bearer bearer-\d+$/);
        return jsonResponse(201, { decision: "AutoAllow" });
      }),
    });
    await hook.decide("t", {});
    await hook.decide("t", {});
    expect(calls).toBe(2);
  });

  it("failing bearer provider → \"deny\"", async () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: async () => {
        throw new Error("token lookup failed");
      },
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "AutoAllow" })),
    });
    expect(await hook.decide("t", {})).toBe("deny");
  });

  it("observe() records timestamps monotonically; decide() is not required for observation", () => {
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "AutoAllow" })),
    });
    hook.observe("a", { v: 1 });
    hook.observe("b", { v: 2 });
    const obs = hook.getObservations();
    expect(obs).toHaveLength(2);
    expect(obs[0]?.name).toBe("a");
    expect(obs[1]?.name).toBe("b");
    expect(obs[1]!.at >= obs[0]!.at).toBe(true);
  });

  it("posts to /permissions/decisions with session_id + tool_name + args body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const hook = new RunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700/",
      bearer: "b",
      sessionId: "ses_x",
      fetchImpl: mockFetch((url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(201, { decision: "AutoAllow" });
      }),
    });
    await hook.decide("echo", { input: "hi" });
    // Trailing slash on baseUrl was stripped, no double-slash:
    expect(capturedUrl).toBe("http://localhost:7700/permissions/decisions");
    expect(capturedBody).toEqual({
      session_id: "ses_x",
      tool_name: "echo",
      args: { input: "hi" },
    });
  });

  it("rejects construction without runnerBaseUrl or sessionId", () => {
    expect(
      () =>
        new RunnerBackedPermissionHook({
          runnerBaseUrl: "",
          bearer: "b",
          sessionId: "s",
        }),
    ).toThrow(/runnerBaseUrl is required/);
    expect(
      () =>
        new RunnerBackedPermissionHook({
          runnerBaseUrl: "http://x",
          bearer: "b",
          sessionId: "",
        }),
    ).toThrow(/sessionId is required/);
  });

  it("factory is equivalent to the constructor", async () => {
    const hook = createRunnerBackedPermissionHook({
      runnerBaseUrl: "http://localhost:7700",
      bearer: "b",
      sessionId: "ses_1",
      fetchImpl: mockFetch(() => jsonResponse(201, { decision: "AutoAllow" })),
    });
    expect(await hook.decide("t", {})).toBe("allow");
  });
});
