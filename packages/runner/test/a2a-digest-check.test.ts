/**
 * §17.2 + §17.2.5 digest recompute tests.
 *
 * Pure-function coverage of computeA2a*Digest + checkTransferDigests,
 * plus wire-integration tests for the §17.2.5 per-method matrix:
 *   - offer-then-transfer happy path
 *   - transfer missing offer state → workflow-state-incompatible
 *   - transfer with digest mismatch → digest-mismatch
 *   - transfer past §17.2.2 deadline → workflow-state-incompatible
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  a2aPlugin,
  A2A_ERROR_CODES,
  A2aTaskRegistry,
  checkTransferDigests,
  computeA2aMessagesDigest,
  computeA2aWorkflowDigest,
  computeA2aResultDigest,
} from "../src/a2a/index.js";

const BEARER = "test-a2a-bearer-" + "y".repeat(20);

async function bootAppWithClock(
  nowFn: () => number,
  opts: { transferDeadlineS?: number } = {},
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  await app.register(a2aPlugin, {
    bearer: BEARER,
    card: { name: "test-agent", version: "1.0", capabilities: [] },
    cardJws: "header.PLACEHOLDER.sig",
    taskRegistry: new A2aTaskRegistry({ retentionWindowS: opts.transferDeadlineS ?? 30 }),
    nowFn,
  });
  return app;
}

describe("computeA2a*Digest (§17.2 formulas)", () => {
  it("messages digest has sha256:<64-hex> shape", () => {
    const d = computeA2aMessagesDigest([{ role: "user", content: "hi" }]);
    expect(d).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("workflow digest is JCS-stable across key-reorder", () => {
    const a = computeA2aWorkflowDigest({ status: "Handoff", task_id: "t", side_effects: [] });
    const b = computeA2aWorkflowDigest({ side_effects: [], task_id: "t", status: "Handoff" });
    expect(a).toBe(b);
  });

  it("result digest has the same formula (formula-only per §17.2.5)", () => {
    const d = computeA2aResultDigest({ artifacts: [], final_state: null, signals: [] });
    expect(d).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("different payloads yield different digests", () => {
    const a = computeA2aMessagesDigest([{ role: "user", content: "a" }]);
    const b = computeA2aMessagesDigest([{ role: "user", content: "b" }]);
    expect(a).not.toBe(b);
  });
});

describe("checkTransferDigests (§17.2.5)", () => {
  const messages = [{ role: "user", content: "hello" }];
  const workflow = { task_id: "t1", status: "Handoff", side_effects: [] };

  it("accept when both digests match", () => {
    const out = checkTransferDigests({
      messages,
      workflow,
      offerMetadata: {
        messages_digest: computeA2aMessagesDigest(messages),
        workflow_digest: computeA2aWorkflowDigest(workflow),
      },
    });
    expect(out).toEqual({ kind: "accept" });
  });

  it("missing-offer-state when offerMetadata is null", () => {
    const out = checkTransferDigests({ messages, workflow, offerMetadata: null });
    expect(out.kind).toBe("missing-offer-state");
  });

  it("digest-mismatch flags messages_digest when only messages differ", () => {
    const out = checkTransferDigests({
      messages,
      workflow,
      offerMetadata: {
        messages_digest: "sha256:" + "a".repeat(64),
        workflow_digest: computeA2aWorkflowDigest(workflow),
      },
    });
    expect(out.kind).toBe("digest-mismatch");
    if (out.kind === "digest-mismatch") expect(out.fieldMismatches).toEqual(["messages_digest"]);
  });

  it("digest-mismatch flags both when both differ", () => {
    const out = checkTransferDigests({
      messages,
      workflow,
      offerMetadata: {
        messages_digest: "sha256:" + "a".repeat(64),
        workflow_digest: "sha256:" + "b".repeat(64),
      },
    });
    expect(out.kind).toBe("digest-mismatch");
    if (out.kind === "digest-mismatch")
      expect(out.fieldMismatches).toEqual(["messages_digest", "workflow_digest"]);
  });
});

describe("A2aTaskRegistry task-execution deadline (§17.2.2 MUST enforce)", () => {
  it("synthesizes timed-out when pre-terminal row ages past deadline", () => {
    const reg = new A2aTaskRegistry({ taskExecutionDeadlineS: 10 });
    reg.record("t1", "accepted", null, 1000);
    expect(reg.get("t1", 1009)?.status).toBe("accepted");
    expect(reg.get("t1", 1010)?.status).toBe("accepted"); // boundary: equal, not "past"
    expect(reg.get("t1", 1011)?.status).toBe("timed-out");
  });

  it("does NOT synthesize timed-out for terminal rows", () => {
    const reg = new A2aTaskRegistry({ taskExecutionDeadlineS: 10 });
    reg.record("t1", "accepted", null, 1000);
    reg.record("t1", "completed", "evt_1");
    expect(reg.get("t1", 9999)?.status).toBe("completed");
  });

  it("omitting nowS from get() returns raw row (no synthesis)", () => {
    const reg = new A2aTaskRegistry({ taskExecutionDeadlineS: 10 });
    reg.record("t1", "accepted", null, 1000);
    expect(reg.get("t1")?.status).toBe("accepted"); // no synthesis when nowS absent
  });

  it("omitting acceptedAtS from record() means no synthesis ever fires", () => {
    const reg = new A2aTaskRegistry({ taskExecutionDeadlineS: 10 });
    reg.record("t1", "accepted", null); // no acceptedAtS
    expect(reg.get("t1", 999999)?.status).toBe("accepted");
  });

  it("default 300s deadline applies when not overridden", () => {
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null, 1000);
    expect(reg.get("t1", 1300)?.status).toBe("accepted");
    expect(reg.get("t1", 1301)?.status).toBe("timed-out");
  });

  it("synthesized timed-out preserves last_event_id", () => {
    const reg = new A2aTaskRegistry({ taskExecutionDeadlineS: 10 });
    reg.record("t1", "executing", "evt_42", 1000);
    const row = reg.get("t1", 2000);
    expect(row?.status).toBe("timed-out");
    expect(row?.last_event_id).toBe("evt_42");
  });
});

describe("A2aTaskRegistry execute hook (§17.2.2.1)", () => {
  it("schedules accepted → executing at N seconds", () => {
    vi.useFakeTimers();
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null);
    reg.scheduleAutoExecute("t1", 2); // N=2
    expect(reg.get("t1")?.status).toBe("accepted");
    vi.advanceTimersByTime(1999);
    expect(reg.get("t1")?.status).toBe("accepted");
    vi.advanceTimersByTime(2);
    expect(reg.get("t1")?.status).toBe("executing");
    vi.useRealTimers();
  });

  it("schedules executing → completed at 2N seconds", () => {
    vi.useFakeTimers();
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null);
    reg.scheduleAutoExecute("t1", 2);
    vi.advanceTimersByTime(3999);
    expect(reg.get("t1")?.status).toBe("executing");
    vi.advanceTimersByTime(2);
    expect(reg.get("t1")?.status).toBe("completed");
    vi.useRealTimers();
  });

  it("cancelAutoExecute stops pending transitions", () => {
    vi.useFakeTimers();
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null);
    reg.scheduleAutoExecute("t1", 5);
    vi.advanceTimersByTime(2000);
    reg.cancelAutoExecute("t1");
    vi.advanceTimersByTime(20000);
    expect(reg.get("t1")?.status).toBe("accepted"); // never transitioned
    vi.useRealTimers();
  });

  it("duplicate scheduleAutoExecute is noop (first schedule wins)", () => {
    vi.useFakeTimers();
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null);
    reg.scheduleAutoExecute("t1", 2);
    // Second call with longer N — MUST NOT replace the first.
    reg.scheduleAutoExecute("t1", 100);
    vi.advanceTimersByTime(2001);
    expect(reg.get("t1")?.status).toBe("executing"); // fired at the original N=2
    vi.useRealTimers();
  });

  it("terminal state recorded via handoff.return + cancelAutoExecute wins over scheduled transitions", () => {
    vi.useFakeTimers();
    const reg = new A2aTaskRegistry();
    reg.record("t1", "accepted", null);
    reg.scheduleAutoExecute("t1", 5);
    vi.advanceTimersByTime(3000);
    reg.cancelAutoExecute("t1");
    reg.record("t1", "completed", "evt_return");
    vi.advanceTimersByTime(20000);
    expect(reg.get("t1")?.status).toBe("completed");
    expect(reg.get("t1")?.last_event_id).toBe("evt_return");
    vi.useRealTimers();
  });
});

describe("A2aTaskRegistry offer retention (§17.2.5 retention window)", () => {
  it("returns offer metadata within retention window", () => {
    const reg = new A2aTaskRegistry({ retentionWindowS: 30 });
    reg.recordOffer("t1", {
      messages_digest: "sha256:" + "a".repeat(64),
      workflow_digest: "sha256:" + "b".repeat(64),
      offeredAtS: 1000,
    });
    expect(reg.getOfferMetadata("t1", 1000)?.messages_digest).toBe("sha256:" + "a".repeat(64));
    expect(reg.getOfferMetadata("t1", 1029)).not.toBeNull();
  });

  it("returns null past retention window", () => {
    const reg = new A2aTaskRegistry({ retentionWindowS: 30 });
    reg.recordOffer("t1", {
      messages_digest: "sha256:" + "a".repeat(64),
      workflow_digest: "sha256:" + "b".repeat(64),
      offeredAtS: 1000,
    });
    expect(reg.getOfferMetadata("t1", 1031)).toBeNull();
  });

  it("returns null for unknown task_id", () => {
    const reg = new A2aTaskRegistry();
    expect(reg.getOfferMetadata("never-seen", 1000)).toBeNull();
  });
});

describe("POST /a2a/v1 — §17.2.5 per-method matrix", () => {
  const messages = [{ role: "user", content: "hello" }];
  const workflow = { task_id: "task_wire", status: "Handoff", side_effects: [] };

  async function offer(app: ReturnType<typeof Fastify>, overrides: Record<string, unknown> = {}): Promise<void> {
    await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "o",
        method: "handoff.offer",
        params: {
          task_id: "task_wire",
          summary: "x",
          messages_digest: computeA2aMessagesDigest(messages),
          workflow_digest: computeA2aWorkflowDigest(workflow),
          capabilities_needed: [],
          ...overrides,
        },
      },
    });
  }

  async function transfer(
    app: ReturnType<typeof Fastify>,
    overrides: Record<string, unknown> = {},
  ): Promise<unknown> {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/v1",
      headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: "t",
        method: "handoff.transfer",
        params: {
          task_id: "task_wire",
          messages,
          workflow,
          billing_tag: "tenant/env",
          correlation_id: "cor_" + "c".repeat(20),
          ...overrides,
        },
      },
    });
    return JSON.parse(res.body);
  }

  it("offer-then-transfer with matching digests → accept (row: handoff.transfer pass)", async () => {
    let now = 1000;
    const app = await bootAppWithClock(() => now);
    await offer(app);
    const body = (await transfer(app)) as { result: { destination_session_id: string } };
    expect(body.result.destination_session_id).toMatch(/^ses_/);
  });

  it("transfer without prior offer → HandoffRejected reason=workflow-state-incompatible", async () => {
    const now = 1000;
    const app = await bootAppWithClock(() => now);
    const body = (await transfer(app)) as { error: { code: number; data: { reason: string } } };
    expect(body.error.code).toBe(A2A_ERROR_CODES.HandoffRejected);
    expect(body.error.data.reason).toBe("workflow-state-incompatible");
  });

  it("transfer with mismatched messages → HandoffRejected reason=digest-mismatch", async () => {
    let now = 1000;
    const app = await bootAppWithClock(() => now);
    await offer(app);
    const body = (await transfer(app, {
      messages: [{ role: "user", content: "TAMPERED" }],
    })) as { error: { code: number; data: { reason: string } } };
    expect(body.error.code).toBe(A2A_ERROR_CODES.HandoffRejected);
    expect(body.error.data.reason).toBe("digest-mismatch");
  });

  it("transfer past retention window → HandoffRejected reason=workflow-state-incompatible", async () => {
    let now = 1000;
    const app = await bootAppWithClock(() => now);
    await offer(app);
    // advance past §17.2.2 default transfer deadline (30 s)
    now = 1031;
    const body = (await transfer(app)) as { error: { code: number; data: { reason: string } } };
    expect(body.error.code).toBe(A2A_ERROR_CODES.HandoffRejected);
    expect(body.error.data.reason).toBe("workflow-state-incompatible");
  });

  it("JCS canonicalization: workflow with reordered keys still matches", async () => {
    let now = 1000;
    const app = await bootAppWithClock(() => now);
    await offer(app);
    const reordered = { side_effects: [], status: "Handoff", task_id: "task_wire" };
    const body = (await transfer(app, { workflow: reordered })) as {
      result?: { destination_session_id: string };
      error?: { code: number };
    };
    expect(body.result?.destination_session_id).toMatch(/^ses_/);
  });
});
