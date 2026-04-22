import { describe, it, expect } from "vitest";
import { fastify } from "fastify";
import {
  InMemoryMemoryStateStore,
  type DataClass
} from "../src/memory/index.js";
import {
  MemoryDeletionForbidden,
  ResidencyViolation,
  residencyDecision,
  residencyAuditPayload,
  InMemorySubjectStore,
  privacyPlugin,
  RetentionSweepScheduler
} from "../src/privacy/index.js";
import {
  permissionsDecisionsPlugin,
  InMemorySessionStore
} from "../src/permission/index.js";
import { AuditChain } from "../src/audit/index.js";
import { ToolRegistry } from "../src/registry/index.js";
import { StreamEventEmitter } from "../src/stream/index.js";
import { BudgetTracker } from "../src/budget/index.js";

// T-12b SV-PRIV runtime coverage:
// SV-PRIV-02: data_class tagging + MemoryDeletionForbidden on sensitive-personal
// SV-PRIV-03: privacy.delete_subject + privacy.export_subject endpoints
// SV-PRIV-04: 24h retention sweep
// SV-PRIV-05: residency layered-defence gate

const FROZEN_NOW = new Date("2026-04-22T15:00:00.000Z");

describe("SV-PRIV-02 — data_class tagging + MemoryDeletionForbidden", () => {
  it("DataClass enum includes sensitive-personal", () => {
    // Compile-time check — if this compiles the type is correct.
    const valid: DataClass[] = [
      "public",
      "internal",
      "confidential",
      "personal",
      "sensitive-personal"
    ];
    expect(valid.length).toBe(5);
  });

  it("recordLoad with a sensitive-personal note throws MemoryDeletionForbidden", () => {
    const store = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
    const SESSION = "ses_sensitivepersonal01";
    store.initFor({ session_id: SESSION });
    expect(() =>
      store.recordLoad(
        SESSION,
        [
          {
            note_id: "n-1",
            summary: "health record",
            data_class: "sensitive-personal",
            composite_score: 0.9
          }
        ],
        1
      )
    ).toThrowError(MemoryDeletionForbidden);
  });

  it("recordLoad with personal (not sensitive-personal) note is allowed", () => {
    const store = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
    const SESSION = "ses_personalok000001";
    store.initFor({ session_id: SESSION });
    expect(() =>
      store.recordLoad(
        SESSION,
        [
          {
            note_id: "n-2",
            summary: "user preferred theme",
            data_class: "personal",
            composite_score: 0.5
          }
        ],
        1
      )
    ).not.toThrow();
    const state = store.get(SESSION);
    expect(state?.in_context_notes[0]?.note_id).toBe("n-2");
  });

  it("guardSensitivePersonal raises with reason sensitive-class-forbidden", () => {
    const store = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
    try {
      store.guardSensitivePersonal([
        { note_id: "nx", data_class: "sensitive-personal" }
      ]);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryDeletionForbidden);
      expect((err as MemoryDeletionForbidden).reason).toBe(
        "sensitive-class-forbidden"
      );
      expect((err as MemoryDeletionForbidden).note_id).toBe("nx");
    }
  });

  it("guardSensitivePersonal returns normally on mixed non-sensitive notes", () => {
    const store = new InMemoryMemoryStateStore({ clock: () => FROZEN_NOW });
    expect(() =>
      store.guardSensitivePersonal([
        { note_id: "n1", data_class: "public" },
        { note_id: "n2", data_class: "internal" },
        { note_id: "n3", data_class: "confidential" },
        { note_id: "n4", data_class: "personal" }
      ])
    ).not.toThrow();
  });
});

describe("SV-PRIV-03 — privacy.delete_subject + privacy.export_subject", () => {
  const BEARER = "priv-operator";

  async function buildApp() {
    const app = fastify();
    const subjectStore = new InMemorySubjectStore();
    const sessionStore = new InMemorySessionStore();
    const chain = new AuditChain(() => FROZEN_NOW);
    await app.register(privacyPlugin, {
      subjectStore,
      sessionStore,
      chain,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      operatorBearer: BEARER
    });
    return { app, subjectStore, sessionStore, chain };
  }

  it("POST /privacy/delete_subject writes SubjectSuppression audit + suppression record", async () => {
    const { app, subjectStore, chain } = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          subject_id: "user-123",
          scope: "memory",
          legal_basis: "legal-obligation",
          operator_kid: "operator-key-v1"
        }
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.subject_id).toBe("user-123");
      expect(body.scope).toBe("memory");
      expect(typeof body.audit_record_hash).toBe("string");
      expect(body.audit_record_hash.length).toBe(64);
      // Suppression mirrored in subject store.
      expect(subjectStore.suppressionsFor("user-123").length).toBe(1);
      // Chain got one record.
      expect(chain.recordCount()).toBe(1);
      const rec = chain.snapshot()[0]!;
      expect(rec.decision).toBe("SubjectSuppression");
      expect(rec.subject_id).toBe("user-123");
      expect(rec.signer_key_id).toBe("operator-key-v1");
    } finally {
      await app.close();
    }
  });

  it("POST /privacy/delete_subject with scope=all writes a single compound suppression", async () => {
    const { app, subjectStore, chain } = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          subject_id: "user-all",
          scope: "all",
          legal_basis: "user-consent",
          operator_kid: "operator-all"
        }
      });
      expect(res.statusCode).toBe(200);
      // All-scope expands to 3 logical scopes but one audit record per §10.7.1.
      expect(chain.recordCount()).toBe(1);
      const suppressions = subjectStore.suppressionsFor("user-all");
      expect(suppressions.length).toBe(1);
      expect(suppressions[0]?.scopes).toEqual(["memory", "audit", "session"]);
    } finally {
      await app.close();
    }
  });

  it("POST /privacy/delete_subject rejects malformed body fields", async () => {
    const { app } = await buildApp();
    try {
      const bad1 = await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: { scope: "memory", legal_basis: "x", operator_kid: "k" }
      });
      expect(bad1.statusCode).toBe(400);
      expect(JSON.parse(bad1.body).detail).toMatch(/subject_id/);

      const bad2 = await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: { subject_id: "s", scope: "bogus", legal_basis: "x", operator_kid: "k" }
      });
      expect(bad2.statusCode).toBe(400);
      expect(JSON.parse(bad2.body).detail).toMatch(/scope/);
    } finally {
      await app.close();
    }
  });

  it("POST /privacy/delete_subject refuses missing bearer with 401", async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { "content-type": "application/json" },
        payload: {
          subject_id: "s",
          scope: "memory",
          legal_basis: "x",
          operator_kid: "k"
        }
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("POST /privacy/export_subject returns JCS-canonical body with redacted-stub suppressions", async () => {
    const { app, subjectStore } = await buildApp();
    try {
      // Seed subject touchpoints.
      subjectStore.recordMemory("user-xyz", {
        note_id: "n1",
        summary: "user prefers dark mode",
        data_class: "personal",
        session_id: "ses_xxx",
        written_at: FROZEN_NOW.toISOString()
      });
      subjectStore.recordAudit("user-xyz", {
        record_id: "r1",
        this_hash: "a".repeat(64),
        decision: "Allow",
        tool: "fs__read_file",
        timestamp: FROZEN_NOW.toISOString()
      });
      subjectStore.recordSession("user-xyz", {
        session_id: "ses_xxx",
        activeMode: "ReadOnly",
        created_at: FROZEN_NOW.toISOString()
      });

      // Pre-redaction: export returns raw bodies.
      const raw = await app.inject({
        method: "POST",
        url: "/privacy/export_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: { subject_id: "user-xyz" }
      });
      expect(raw.statusCode).toBe(200);
      const rawBody = JSON.parse(raw.body);
      expect(rawBody.memory[0].summary).toBe("user prefers dark mode");
      expect(rawBody.audit[0].decision).toBe("Allow");
      expect(rawBody.sessions[0].activeMode).toBe("ReadOnly");

      // Suppress memory scope, re-export.
      await app.inject({
        method: "POST",
        url: "/privacy/delete_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          subject_id: "user-xyz",
          scope: "memory",
          legal_basis: "legal-obligation",
          operator_kid: "operator-v1"
        }
      });
      const redacted = await app.inject({
        method: "POST",
        url: "/privacy/export_subject",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: { subject_id: "user-xyz" }
      });
      expect(redacted.statusCode).toBe(200);
      const redBody = JSON.parse(redacted.body);
      expect(redBody.memory[0].summary).toMatch(/redacted/);
      // Audit + session still raw (only memory was suppressed).
      expect(redBody.audit[0].decision).toBe("Allow");
      expect(redBody.sessions[0].activeMode).toBe("ReadOnly");
      // Suppressions list is present.
      expect(redBody.suppressions.length).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("SV-PRIV-04 — 24h retention sweep", () => {
  it("runNow executes a sweep + logs it + advances lastRunAt", () => {
    const sweeper = new RetentionSweepScheduler({
      clock: () => FROZEN_NOW,
      log: () => undefined
    });
    const outcome = sweeper.runNow();
    expect(outcome.ran_at).toBe(FROZEN_NOW.toISOString());
    expect(sweeper.outcomesSnapshot().length).toBe(1);
    expect(sweeper.lastRunIso()).toBe(FROZEN_NOW.toISOString());
  });

  it("sweep hooks supply tombstone + redact counts to the outcome", () => {
    const sweeper = new RetentionSweepScheduler({
      clock: () => FROZEN_NOW,
      log: () => undefined,
      hooks: {
        sweepMemory: () => 4,
        sweepSessionBodies: () => 2,
        sweepAuditPersonal: () => 7,
        inspected: () => 20
      }
    });
    const outcome = sweeper.runNow();
    expect(outcome.records_tombstoned_memory).toBe(4);
    expect(outcome.records_tombstoned_session).toBe(2);
    expect(outcome.records_redacted_audit).toBe(7);
    expect(outcome.records_inspected).toBe(20);
  });

  it("24h elapsed tick fires sweep; sub-threshold tick does not", () => {
    let now = new Date("2026-04-22T15:00:00.000Z");
    const timerStubs: (() => void)[] = [];
    const sweeper = new RetentionSweepScheduler({
      clock: () => now,
      log: () => undefined,
      intervalMs: 24 * 60 * 60 * 1000,
      tickIntervalMs: 60_000,
      setInterval: ((fn: () => void): ReturnType<typeof setInterval> => {
        timerStubs.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as unknown as typeof clearInterval
    });
    sweeper.start();
    // First tick at 60s elapsed — no fire.
    now = new Date(now.getTime() + 60_000);
    timerStubs[0]?.();
    expect(sweeper.outcomesSnapshot().length).toBe(0);
    // Advance to 24h — the next tick fires.
    now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    timerStubs[0]?.();
    expect(sweeper.outcomesSnapshot().length).toBe(1);
    sweeper.stop();
  });

  it("start/stop is idempotent", () => {
    const sweeper = new RetentionSweepScheduler({
      clock: () => FROZEN_NOW,
      log: () => undefined
    });
    sweeper.start();
    sweeper.start(); // no-op
    sweeper.stop();
    sweeper.stop(); // no-op
    expect(sweeper.lastRunIso()).toBe(FROZEN_NOW.toISOString());
  });
});

describe("SV-PRIV-05 — residency layered-defence gate", () => {
  it("empty data_residency = no constraint → allow", () => {
    const decision = residencyDecision({
      tool: "fs__read_file",
      data_residency: [],
      declared_location: ["US"]
    });
    expect(decision.outcome).toBe("allow");
  });

  it("declared location intersects pin → allow", () => {
    const decision = residencyDecision({
      tool: "fs__read_file",
      data_residency: ["US", "CA"],
      declared_location: ["US"]
    });
    expect(decision.outcome).toBe("allow");
  });

  it("declared location disjoint from pin → deny (tool-declaration-mismatch)", () => {
    const decision = residencyDecision({
      tool: "fs__read_file",
      data_residency: ["US", "CA"],
      declared_location: ["EU"]
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.error).toBeInstanceOf(ResidencyViolation);
      expect(decision.error.sub_reason).toBe("tool-declaration-mismatch");
    }
  });

  it("tool without declared_location → deny (unknown-region)", () => {
    const decision = residencyDecision({
      tool: "fs__read_file",
      data_residency: ["US"]
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.error.sub_reason).toBe("unknown-region");
    }
  });

  it("attested location disagrees with declaration → deny (attestation-mismatch)", () => {
    const decision = residencyDecision({
      tool: "fs__read_file",
      data_residency: ["US"],
      declared_location: ["US"],
      attested_location: ["EU"]
    });
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny") {
      expect(decision.error.sub_reason).toBe("attestation-mismatch");
    }
  });

  it("residencyAuditPayload surfaces all four layers + decision", () => {
    const allow = residencyDecision({
      tool: "fs__read_file",
      data_residency: ["US"],
      declared_location: ["US"],
      attested_location: ["US"],
      network_signal_regions: ["US"]
    });
    const p = residencyAuditPayload(allow);
    expect(p.decision).toBe("allow");
    expect(p.declared_location).toEqual(["US"]);
    expect(p.attested_location).toEqual(["US"]);
    expect(p.network_signal_regions).toEqual(["US"]);
  });

  it("decisions-route integration: empty-intersection → 403 PermissionDenied(residency-violation) + audit row", async () => {
    const store = new InMemorySessionStore();
    const SESSION = "ses_residency0000000001";
    const BEARER = "priv-res-bearer";
    store.register(SESSION, BEARER, { activeMode: "ReadOnly", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
    ]);
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const tracker = new BudgetTracker({ maxTokensPerRun: 200_000 });
    const app = fastify();
    await app.register(permissionsDecisionsPlugin, {
      registry,
      sessionStore: store,
      chain,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      activeCapability: "ReadOnly",
      runnerVersion: "1.0",
      emitter,
      budgetTracker: tracker,
      dataResidency: ["US", "CA"],
      toolResidency: (_name) => ({ declared_location: ["EU"] })
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:aaaa222222222222222222222222222222222222222222222222222222222222"
        }
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("PermissionDenied");
      expect(body.reason).toBe("residency-violation");
      expect(body.sub_reason).toBe("tool-declaration-mismatch");
      expect(body.residency.decision).toBe("deny");
      // Audit row recorded so the decision trail is preserved.
      expect(chain.recordCount()).toBeGreaterThanOrEqual(1);
      const residencyRow = chain.snapshot().find((r) => r.decision === "ResidencyCheck");
      expect(residencyRow).toBeDefined();
      expect(residencyRow?.tool).toBe("fs__read_file");
      expect(residencyRow?.subject_id).toBe("test-user");
    } finally {
      await app.close();
    }
  });

  it("decisions-route integration: matching residency → allow + audit row with decision=allow", async () => {
    const store = new InMemorySessionStore();
    const SESSION = "ses_residencyok0000002";
    const BEARER = "priv-res-ok-bearer";
    store.register(SESSION, BEARER, { activeMode: "ReadOnly", canDecide: true });
    const chain = new AuditChain(() => FROZEN_NOW);
    const registry = new ToolRegistry([
      { name: "fs__read_file", risk_class: "ReadOnly", default_control: "AutoAllow" }
    ]);
    const emitter = new StreamEventEmitter({ clock: () => FROZEN_NOW });
    const tracker = new BudgetTracker({ maxTokensPerRun: 200_000 });
    const app = fastify();
    await app.register(permissionsDecisionsPlugin, {
      registry,
      sessionStore: store,
      chain,
      readiness: { check: () => null },
      clock: () => FROZEN_NOW,
      activeCapability: "ReadOnly",
      runnerVersion: "1.0",
      emitter,
      budgetTracker: tracker,
      dataResidency: ["US"],
      toolResidency: (_name) => ({ declared_location: ["US"] })
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/permissions/decisions",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        payload: {
          tool: "fs__read_file",
          session_id: SESSION,
          args_digest: "sha256:bbbb333333333333333333333333333333333333333333333333333333333333"
        }
      });
      // Decision should be Allow (ReadOnly + ReadOnly) and residency audit row present.
      expect(res.statusCode).toBe(201);
      const residencyRow = chain.snapshot().find((r) => r.decision === "ResidencyCheck");
      expect(residencyRow).toBeDefined();
      expect((residencyRow?.residency as { decision: string }).decision).toBe("allow");
    } finally {
      await app.close();
    }
  });
});
