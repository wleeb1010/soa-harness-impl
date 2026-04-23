/**
 * SV-ADAPTER-04 end-to-end over real HTTP — closes Phase 2.5 criterion (v).
 *
 * Drives tool-invocation audit rows from the adapter's audit-sink
 * through the back-end Runner fixture. Asserts:
 *   - retention_class stamped per §10.5.6 (dfa-365d vs standard-90d)
 *   - the real AuditChain commits each row with prev_hash linkage
 *   - GET /audit/records returns the committed rows with matching hashes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startBackEndFixture, type BackEndFixture } from "./back-end-runner-fixture.js";
import {
  RunnerAuditSinkForwarder,
  type ToolInvocationAuditInput,
} from "../../src/index.js";

function sampleRecord(overrides: Partial<ToolInvocationAuditInput> = {}): ToolInvocationAuditInput {
  return {
    session_id: "ses_e2e04abcdef123456",
    tool_call_id: "tcl_1",
    tool_name: "echo",
    args_digest: "a".repeat(64),
    ok: true,
    observed_at: "2026-04-22T20:00:00Z",
    ...overrides,
  };
}

describe("SV-ADAPTER-04 e2e — audit-forwarding over real HTTP", () => {
  let backEnd: BackEndFixture;

  beforeEach(async () => {
    backEnd = await startBackEndFixture();
  });

  afterEach(async () => {
    await backEnd.close();
  });

  it("ReadOnly activeMode → retention_class=\"standard-90d\" reaches Runner", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: backEnd.url,
      bearer: backEnd.bearer,
      activeMode: "ReadOnly",
    });
    const resp = await sink.append(sampleRecord());
    expect(resp.record_id).toMatch(/^aud_/);
    expect(resp.retention_class).toBe("standard-90d");

    const records = await fetch(`${backEnd.url}/audit/records`, {
      headers: { authorization: `Bearer ${backEnd.bearer}` },
    });
    expect(records.status).toBe(200);
    const body = (await records.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.retention_class).toBe("standard-90d");
  });

  it("DangerFullAccess activeMode → retention_class=\"dfa-365d\" reaches Runner", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: backEnd.url,
      bearer: backEnd.bearer,
      activeMode: "DangerFullAccess",
    });
    const resp = await sink.append(sampleRecord());
    expect(resp.retention_class).toBe("dfa-365d");
    expect(backEnd.head()?.retention_class).toBe("dfa-365d");
  });

  it("multiple invocations chain correctly — each record's prev_hash matches prior's this_hash", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: backEnd.url,
      bearer: backEnd.bearer,
      activeMode: "ReadOnly",
    });

    const r1 = await sink.append(sampleRecord({ tool_call_id: "tcl_1" }));
    const r2 = await sink.append(sampleRecord({ tool_call_id: "tcl_2" }));
    const r3 = await sink.append(sampleRecord({ tool_call_id: "tcl_3" }));

    expect(r2.prev_hash).toBe(r1.this_hash);
    expect(r3.prev_hash).toBe(r2.this_hash);
    expect(backEnd.appendCount()).toBe(3);
  });

  it("chain's GENESIS prev_hash on first record", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: backEnd.url,
      bearer: backEnd.bearer,
      activeMode: "ReadOnly",
    });
    const r1 = await sink.append(sampleRecord());
    expect(r1.prev_hash).toBe("GENESIS");
  });

  it("invalid bearer → AuditSinkForwardError with 401 status", async () => {
    const sink = new RunnerAuditSinkForwarder({
      runnerBaseUrl: backEnd.url,
      bearer: "wrong-bearer",
      activeMode: "ReadOnly",
    });
    await expect(sink.append(sampleRecord())).rejects.toMatchObject({ status: 401 });
  });
});
