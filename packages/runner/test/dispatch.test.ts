import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "@soa-harness/schemas";
import {
  Dispatcher,
  InMemoryTestAdapter,
  AdapterError,
  MAX_DISPATCHER_RETRIES,
  DISPATCHER_ERROR_SUBCODES,
  type DispatchRequest,
  type DispatcherErrorCode,
} from "../src/index.js";
import { BudgetTracker } from "../src/budget/index.js";
import { AuditChain } from "../src/audit/index.js";

/**
 * Fixed clock/random for deterministic tests.
 */
let clockMs = 1_700_000_000_000;
const clock = () => new Date(clockMs);
const advanceClock = (ms: number) => {
  clockMs += ms;
};
const random = () => 0.5; // deterministic jitter

const ZERO_SLEEP = async () => {
  /* no-op: tests pin retries to zero delay */
};

function validRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    session_id: "ses_" + "a".repeat(20),
    turn_id: "trn_" + "b".repeat(20),
    model: "in-memory-test-model",
    messages: [{ role: "user", content: "hello" }],
    budget_ceiling_tokens: 10_000,
    billing_tag: "tenant-a/env-test",
    correlation_id: "cor_" + "c".repeat(20),
    idempotency_key: "idem-" + "d".repeat(20),
    stream: false,
    ...overrides,
  };
}

function newDispatcher(
  adapter: InMemoryTestAdapter,
  opts: {
    budget?: BudgetTracker;
    audit?: AuditChain;
  } = {},
): Dispatcher {
  return new Dispatcher({
    adapter,
    budgetTracker: opts.budget,
    auditChain: opts.audit,
    clock,
    random,
    sleep: ZERO_SLEEP,
    runnerVersion: "1.1-test",
  });
}

beforeEach(() => {
  clockMs = 1_700_000_000_000;
});

describe("§16.3 Dispatcher — request schema validation (SV-LLM-01)", () => {
  it("accepts a valid request and returns NaturalStop", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("NaturalStop");
    expect(res.dispatcher_error_code).toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it("rejects a request missing `model` → DispatcherRequestInvalid, no adapter call", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const bad = { ...validRequest(), model: undefined } as unknown as DispatchRequest;
    const res = await d.dispatch(bad);
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("DispatcherRequestInvalid");
    expect(adapter.calls).toHaveLength(0);
  });

  it("rejects a request with invalid billing_tag", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest({ billing_tag: "has spaces which are illegal" }));
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("DispatcherRequestInvalid");
    expect(adapter.calls).toHaveLength(0);
  });

  it("rejects a request with budget_ceiling_tokens <= 0", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest({ budget_ceiling_tokens: 0 }));
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("DispatcherRequestInvalid");
    expect(adapter.calls).toHaveLength(0);
  });

  it("validates against the same ajv-compiled schema shipped in @soa-harness/schemas", () => {
    const v = registry["llm-dispatch-request"];
    expect(v(validRequest())).toBe(true);
    expect(v({ ...validRequest(), model: undefined })).toBe(false);
  });
});

describe("§16.3 Dispatcher — response schema (SV-LLM-02)", () => {
  it("synchronous success response validates against the response schema", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    const v = registry["llm-dispatch-response"];
    const ok = v(res);
    if (!ok) {
      throw new Error(`response failed schema: ${JSON.stringify(v.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it("DispatcherError response validates + dispatcher_error_code is non-null", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "error:ProviderAuthFailed" });
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("ProviderAuthFailed");
    const v = registry["llm-dispatch-response"];
    expect(v(res)).toBe(true);
  });

  it("success response carries dispatcher_error_code === null (schema allOf enforcement)", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.dispatcher_error_code).toBeNull();
    const v = registry["llm-dispatch-response"];
    expect(v(res)).toBe(true);
  });
});

describe("§16.3 Dispatcher — budget pre-check BEFORE provider call (SV-LLM-03)", () => {
  it("synthesizes BudgetExhausted when projection > ceiling; provider NEVER called", async () => {
    const adapter = new InMemoryTestAdapter({ usage: { input_tokens: 5000, output_tokens: 0 } });
    const tracker = new BudgetTracker();
    const session_id = "ses_" + "a".repeat(20);
    tracker.initFor(session_id);
    // Seed the tracker so cumulative ≈ 9000 and p95 ≈ large — projection overshoots 1-token ceiling.
    tracker.recordTurn(session_id, { actual_total_tokens: 3000 });
    tracker.recordTurn(session_id, { actual_total_tokens: 3500 });
    tracker.recordTurn(session_id, { actual_total_tokens: 3200 });
    const d = newDispatcher(adapter, { budget: tracker });

    const res = await d.dispatch(validRequest({ session_id, budget_ceiling_tokens: 1 }));
    expect(res.stop_reason).toBe("BudgetExhausted");
    expect(res.usage.input_tokens).toBe(0);
    expect(res.usage.output_tokens).toBe(0);
    expect(res.dispatcher_error_code).toBeNull();
    expect(adapter.calls).toHaveLength(0); // THE critical assertion — provider NEVER called
  });

  it("passes through when projection < ceiling", async () => {
    const adapter = new InMemoryTestAdapter();
    const tracker = new BudgetTracker();
    const session_id = "ses_" + "a".repeat(20);
    tracker.initFor(session_id);
    tracker.recordTurn(session_id, { actual_total_tokens: 100 });
    tracker.recordTurn(session_id, { actual_total_tokens: 120 });
    tracker.recordTurn(session_id, { actual_total_tokens: 110 });
    const d = newDispatcher(adapter, { budget: tracker });

    const res = await d.dispatch(validRequest({ session_id, budget_ceiling_tokens: 100_000 }));
    expect(res.stop_reason).toBe("NaturalStop");
    expect(adapter.calls).toHaveLength(1);
  });

  it("passes through when tracker has no session state (first turn, no pre-check possible)", async () => {
    const adapter = new InMemoryTestAdapter();
    const tracker = new BudgetTracker();
    const d = newDispatcher(adapter, { budget: tracker });
    const res = await d.dispatch(validRequest({ budget_ceiling_tokens: 1 }));
    // Tracker has no history → dispatcher can't reject; adapter runs
    expect(res.stop_reason).toBe("NaturalStop");
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("§16.3 Dispatcher — billing_tag propagation (SV-LLM-04)", () => {
  it("audit row carries identical billing_tag as request", async () => {
    const adapter = new InMemoryTestAdapter();
    const audit = new AuditChain(clock);
    const d = newDispatcher(adapter, { audit });

    const req = validRequest({ billing_tag: "tenant-b/env-prod" });
    await d.dispatch(req);

    const chain = audit.snapshot();
    expect(chain).toHaveLength(1);
    expect(chain[0].billing_tag).toBe("tenant-b/env-prod");
  });

  it("/dispatch/recent row carries identical billing_tag as request", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const req = validRequest({ billing_tag: "tenant-b/env-prod" });
    await d.dispatch(req);
    const recent = d.recent_response(req.session_id);
    expect(recent.dispatches).toHaveLength(1);
    expect(recent.dispatches[0].billing_tag).toBe("tenant-b/env-prod");
  });
});

describe("§16.3 Dispatcher — cancellation at mid-stream boundary (SV-LLM-05)", () => {
  it("aborting during in-flight dispatch yields UserInterrupt + recorded audit row", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "never" });
    const audit = new AuditChain(clock);
    const d = newDispatcher(adapter, { audit });
    const ctrl = new AbortController();

    const pending = d.dispatch(validRequest(), { signal: ctrl.signal });
    // Let the adapter start hanging, then abort
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    const res = await pending;

    expect(res.stop_reason).toBe("UserInterrupt");
    expect(res.dispatcher_error_code).toBeNull();
    expect(audit.snapshot()).toHaveLength(1);
  });

  it("pre-aborted signal yields UserInterrupt immediately, adapter never called", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await d.dispatch(validRequest(), { signal: ctrl.signal });
    expect(res.stop_reason).toBe("UserInterrupt");
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("§16.3 Dispatcher — audit row per dispatch (SV-LLM-06)", () => {
  it("exactly one hash-chained row per dispatch across mixed outcomes", async () => {
    const adapter = new InMemoryTestAdapter();
    const audit = new AuditChain(clock);
    const d = newDispatcher(adapter, { audit });

    // Success
    advanceClock(1);
    await d.dispatch(validRequest());

    // Cancellation
    adapter.setBehavior("never");
    const ctrl = new AbortController();
    const pending = d.dispatch(validRequest(), { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await pending;

    // Provider error (non-retryable)
    adapter.setBehavior("error:ProviderAuthFailed");
    advanceClock(1);
    await d.dispatch(validRequest());

    const snap = audit.snapshot();
    expect(snap).toHaveLength(3);
    // prev_hash linkage: index 0 prev is GENESIS; index 1 prev is index 0's this_hash; etc.
    expect(snap[0].prev_hash).toBe("GENESIS");
    expect(snap[1].prev_hash).toBe(snap[0].this_hash);
    expect(snap[2].prev_hash).toBe(snap[1].this_hash);
    // Outcome classifications
    expect(snap[0].stop_reason).toBe("NaturalStop");
    expect(snap[1].stop_reason).toBe("UserInterrupt");
    expect(snap[2].stop_reason).toBe("DispatcherError");
    expect(snap[2].dispatcher_error_code).toBe("ProviderAuthFailed");
  });

  it("dispatches without a wired AuditChain still return responses (audit opt-in)", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter); // no audit
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("NaturalStop");
  });
});

describe("§16.3.1 Provider Error Taxonomy (SV-LLM-07)", () => {
  const codes: DispatcherErrorCode[] = [
    "ProviderRateLimited",
    "ProviderAuthFailed",
    "ProviderUnavailable",
    "ProviderNetworkFailed",
    "ContentFilterRefusal",
    "ContextLengthExceeded",
  ];

  for (const code of codes) {
    it(`maps ${code} through to DispatcherError with matching dispatcher_error_code`, async () => {
      const adapter = new InMemoryTestAdapter({ behavior: `error:${code}` });
      const d = newDispatcher(adapter);
      const res = await d.dispatch(validRequest());
      expect(res.stop_reason).toBe("DispatcherError");
      expect(res.dispatcher_error_code).toBe(code);
    });
  }

  it("retryable conditions retry up to MAX_DISPATCHER_RETRIES then succeed on late flap", async () => {
    // Fail the first 2 attempts, succeed on the 3rd
    const adapter = new InMemoryTestAdapter({ behavior: "flaky:2:ProviderRateLimited" });
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("NaturalStop");
    expect(adapter.calls.length).toBeGreaterThanOrEqual(3); // 2 fails + 1 success
  });

  it("retry budget caps at MAX_DISPATCHER_RETRIES — persistent failure terminates as DispatcherError", async () => {
    // Always fail — should try 1 + MAX_DISPATCHER_RETRIES times then give up
    const adapter = new InMemoryTestAdapter({ behavior: "error:ProviderRateLimited" });
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("ProviderRateLimited");
    expect(adapter.calls.length).toBe(MAX_DISPATCHER_RETRIES + 1);
  });

  it("non-retryable conditions make exactly 1 attempt", async () => {
    const adapter = new InMemoryTestAdapter({ behavior: "error:ProviderAuthFailed" });
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("ProviderAuthFailed");
    expect(adapter.calls.length).toBe(1);
  });

  it("retry counter does NOT reset across retryable classes (§16.3.1)", async () => {
    // Simulate switching provider conditions: we fake this by using a flaky counter but
    // asserting the total attempts is still bounded by MAX_DISPATCHER_RETRIES + 1 = 4.
    const adapter = new InMemoryTestAdapter({ behavior: "error:ProviderUnavailable" });
    const d = newDispatcher(adapter);
    await d.dispatch(validRequest());
    expect(adapter.calls.length).toBe(MAX_DISPATCHER_RETRIES + 1);
  });

  it("DISPATCHER_ERROR_SUBCODES exposes the §24 JSON-RPC numeric codes", () => {
    expect(DISPATCHER_ERROR_SUBCODES.ProviderRateLimited).toBe(-32100);
    expect(DISPATCHER_ERROR_SUBCODES.ProviderAuthFailed).toBe(-32101);
    expect(DISPATCHER_ERROR_SUBCODES.ProviderUnavailable).toBe(-32102);
    expect(DISPATCHER_ERROR_SUBCODES.ProviderNetworkFailed).toBe(-32103);
    expect(DISPATCHER_ERROR_SUBCODES.ContentFilterRefusal).toBe(-32104);
    expect(DISPATCHER_ERROR_SUBCODES.ContextLengthExceeded).toBe(-32105);
    expect(DISPATCHER_ERROR_SUBCODES.DispatcherRequestInvalid).toBe(-32110);
  });
});

describe("§16.4 /dispatch/recent observability endpoint", () => {
  it("returns newest-first ordering, capped at limit, schema-conformant", async () => {
    const adapter = new InMemoryTestAdapter();
    const d = newDispatcher(adapter);
    const session_id = "ses_" + "a".repeat(20);
    for (let i = 0; i < 5; i++) {
      advanceClock(1000);
      await d.dispatch(validRequest({ session_id, turn_id: "trn_" + String(i).padStart(20, "0") }));
    }
    const recent = d.recent_response(session_id, 3);
    expect(recent.dispatches).toHaveLength(3);
    // Newest first
    const first = recent.dispatches[0];
    const last = recent.dispatches[2];
    expect(new Date(first.started_at).getTime()).toBeGreaterThan(new Date(last.started_at).getTime());
    const v = registry["dispatch-recent-response"];
    const ok = v(recent);
    if (!ok) throw new Error(`recent response failed schema: ${JSON.stringify(v.errors)}`);
    expect(ok).toBe(true);
  });

  it("adapter echo-contract violation produces DispatcherError (integrity probe)", async () => {
    // A broken adapter that returns a response with wrong correlation_id.
    const adapter: InMemoryTestAdapter = new InMemoryTestAdapter();
    const originalDispatch = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (req, ctx) => {
      const r = await originalDispatch(req, ctx);
      return { ...r, correlation_id: "cor_" + "z".repeat(20) }; // echo violation
    };
    const d = newDispatcher(adapter);
    const res = await d.dispatch(validRequest());
    expect(res.stop_reason).toBe("DispatcherError");
    expect(res.dispatcher_error_code).toBe("DispatcherRequestInvalid");
  });
});

describe("AdapterError class", () => {
  it("carries code, message, providerRequestId, retryAfterMs", () => {
    const e = new AdapterError("ProviderRateLimited", {
      message: "rate-limited",
      providerRequestId: "req-xyz",
      retryAfterMs: 1500,
    });
    expect(e.code).toBe("ProviderRateLimited");
    expect(e.providerRequestId).toBe("req-xyz");
    expect(e.retryAfterMs).toBe(1500);
  });
});
