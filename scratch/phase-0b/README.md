# Phase 0b — LangGraph Pre-Dispatch Permission Interception (Spike)

**Status:** ✅ PASS — all three acceptance criteria met.
**Duration:** day 1 (well under the 3-day rollback budget).
**Verdict:** proceed to Phase 1 (adapter package scaffold at `packages/langgraph-adapter/`). No advisory-mode fallback needed.

## What this spike proves

SOA-Harness Core §18.5.2 (M4 Phase 0a, spec commit `654dc7b`, L-52) requires
that an adapter **MUST intercept every tool invocation BEFORE the host
framework executes the tool**. This is the single hardest correctness
invariant in the adapter conformance surface — post-dispatch "undo" is
explicitly non-conformant because `Mutating` / `Destructive` tools have
already produced side effects by the time an after-the-fact denial fires.

The spike is a throwaway (`~160 LOC src + ~120 LOC test`) that demonstrates
the invariant holds on LangGraph.js using only the public API.

## Strategy used: substitute a permission-aware tool executor

§18.5.2 item 2 explicitly enumerates two conformant approaches:

1. Wrap the host framework's tool-dispatch entry point (subclass
   `ToolNode.invoke`).
2. Substitute a permission-aware tool executor at host-framework
   registration time.

We implemented **(2)**. The graph registers a single custom node named
`"tools"` which:

1. Iterates `tool_calls` from the last `AIMessage`.
2. Calls `hook.observe(name, args)` — this is the **pre-dispatch hook**.
3. Calls `hook.decide(name, args)` and partitions into `approved` / `denied`.
4. For `denied` calls, synthesizes a `ToolMessage { status: "error" }`
   without any dispatch.
5. For `approved` calls, synthesizes a filtered `AIMessage` containing
   **only** approved `tool_calls` and delegates to the underlying
   `ToolNode.invoke(...)`.

The underlying LangGraph `ToolNode` never sees denied calls — the host
framework's dispatcher is not even reached on the deny path. This is
strictly stronger than the spec requires (which permits blocking the
dispatcher until a decision arrives); we bypass the dispatcher entirely
for denied calls.

**Why (2) over (1):** subclassing `ToolNode.invoke` directly requires
reaching into the `RunnableCallable` constructor pattern
(`super({ func: ... })`) which couples us to LangGraph.js internals.
Substitution uses only `new ToolNode(tools)` + `toolNode.invoke(state)`,
both public API, so the adapter survives LangGraph version churn.

## Acceptance criteria

| # | Criterion | Verification | Result |
|---|---|---|---|
| (i) | Hook observes tool name + args BEFORE underlying tool function | Temporal proof: `observation.at < sentinelFiredAt` using `process.hrtime.bigint()` (nanosecond clock) | ✅ PASS |
| (ii) | StateGraph invariants preserved (compile + state transitions complete) | `buildSpikeGraph(...).compile()` returns; both `allow` and `deny` graph.invoke calls return final state with 3 messages (Human + AI + Tool/Denial) | ✅ PASS |
| (iii) | Deny decision CAUSES tool function NOT to execute (sentinel-verified) | `state.sentinelFiredAt === null` after `deny` graph.invoke; `!== null` after `allow` graph.invoke (sanity-wired counter-test prevents trivially-passing sentinel) | ✅ PASS |

## Test results

```
✓ test/spike.test.ts (5 tests) 43ms
  ✓ (iii) deny decision prevents the underlying tool function from executing
  ✓ (i) observation timestamp strictly precedes tool execution on the allow path
  ✓ (ii) graph compiles and completes a full state transition on both decision paths
  ✓ (iii-bis) allow decision does execute the tool — confirms sentinel is wired correctly
  ✓ mixed-batch: multi-tool AIMessage applies per-call decisions independently

Test Files  1 passed (1)
     Tests  5 passed (5)
  Duration  537ms
```

TypeScript: `npx tsc --noEmit` clean.

## LangGraph API quirks discovered

None blocking. The spike uses only public LangGraph.js 0.2.x API:

- `StateGraph` + `Annotation.Root` + `messagesStateReducer` for state
  topology.
- `ToolNode` from `@langchain/langgraph/prebuilt` as the underlying
  dispatcher. Notably, `toolNode.invoke(state)` works the same way from
  **inside** another graph node as it does as a registered node — there
  is no hidden coupling to the graph's execution context. This was the
  key feasibility question and the answer is: nested delegation is fine.
- `tool()` helper from `@langchain/core/tools` + zod for tool schema.

One TS-level nuance: `as const` on a ternary string expression is not
permitted by TS 5.6 — use an explicit `Promise<"allow" | "deny">` return
type annotation instead. Noted in test code.

## Versions exercised

```
@langchain/core       0.3.80
@langchain/langgraph  0.2.74
(deduped via langgraph-checkpoint 0.0.18 and langgraph-sdk 0.0.112)
Node.js               20 (project engines floor)
TypeScript            5.6.3
vitest                2.1.9
zod                   3.23.8+
```

## Implications for Phase 1 (packages/langgraph-adapter/)

1. **Architecture:** register a custom node between the LLM node and the
   ToolNode, OR replace the ToolNode entirely with a permission-aware
   executor. Either is equivalent.

2. **PermissionPrompt emission:** the hook layer where we currently have
   `hook.observe(...)` is exactly where a real adapter will emit the
   `PermissionPrompt` StreamEvent (§14.1.1) to the observability channel.
   This matches the spec's §18.5.2 item 5 ordering assertion
   (`PermissionPrompt.occurred_at < tool.invoke.occurred_at <
   PermissionDecision.occurred_at`) — our spike already satisfies this
   via `process.hrtime.bigint()` ordering.

3. **Blocking semantics:** the adapter will need to `await` the
   `PermissionDecision` before proceeding (spec §18.5.2 item 1d —
   "Block the host framework's tool dispatcher until a
   PermissionDecision is available"). Our `hook.decide(...)` is already
   `async` so this is native to the design.

4. **args_digest:** the adapter will compute `SHA-256(JCS(args))` between
   the observe and decide steps. This is mechanical — the spike's
   `observations` array records raw args; the production path will add a
   canonical-JCS digest alongside.

5. **Fallback NOT needed:** advisory-mode (§18.5.2 item 4) is spec'd as
   a permitted fallback for adapters that cannot guarantee pre-dispatch
   interception. This spike proves LangGraph.js does **not** need that
   fallback — full Core-profile adapter conformance is achievable.

## Out of scope for this spike (deferred to Phase 1)

- PermissionPrompt StreamEvent emission (stub here; real in Phase 1).
- args_digest computation.
- Hook-pipeline integration (§15 PreToolUse / PostToolUse outcome
  events).
- Handoff to real `/permissions/decisions` HTTP endpoint.
- Multi-turn graph topology (LLM → gate → tools → LLM loop).
- LangGraph checkpointing interaction with denied calls.
- Event mapping to SOA StreamEvent types per §14.6.

## Files in this spike

```
scratch/phase-0b/
├── package.json            # isolated npm install (NOT in pnpm workspace)
├── tsconfig.json
├── vitest.config.ts
├── src/
│   └── spike.ts            # ~160 LOC
├── test/
│   └── spike.test.ts       # ~120 LOC, 5 tests
└── README.md               # this file
```

`scratch/` is excluded from the pnpm workspace globs (`packages/*`, `tools/*`),
so this spike is fully isolated and does not affect the monorepo build.

## Reproducing

```bash
cd scratch/phase-0b
npm install
npx vitest run
npx tsc --noEmit
```

## Rollback trigger status

Phase 0a's rollback trigger was: "spike incomplete by EOD day 3 OR
acceptance criteria cannot all be met → escalate to spec session; pivot
adapter design to advisory-mode fallback per §18.5.2."

**Not triggered.** Spike complete day 1, all three criteria cleanly met.
Proceed to Phase 0c external reviewer confirmation + Phase 1 adapter
package scaffold.
