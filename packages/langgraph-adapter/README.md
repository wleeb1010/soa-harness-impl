# @soa-harness/langgraph-adapter

SOA-Harness adapter for LangGraph.js. Wraps an existing LangGraph
`StateGraph` so the resulting runtime satisfies §18.5 Adapter
Conformance (Core profile) without forcing you to rewrite your agent
against a native SOA Runner.

## Status

**Phase 1 scaffold — compliance-wrapper only.**

- ✅ Pre-dispatch permission interception (`buildPermissionAwareToolNode`)
- ⏳ HTTP permission hook (`POST /permissions/decisions`) — Phase 2
- ⏳ StreamEvent synthesis (§14.6 mapping, 40 LangGraph events → 27 SOA) — Phase 2
- ⏳ Audit-sink forwarding (§10.5 hash chain + retention_class) — Phase 2
- ⏳ `SV-ADAPTER-01..04` conformance wired — Phase 2

## Pre-dispatch interception (§18.5.2)

LangGraph's `ToolNode` dispatches tools eagerly. The spec's
§18.5.2 item 1 requires that adapters intercept **before** the host
framework executes the tool — post-dispatch "undo" is explicitly
non-conformant because `Mutating` / `Destructive` tools have already
produced side effects by the time an after-the-fact denial fires.

This package ships the substitute-permission-aware-executor pattern
validated by the Phase 0b feasibility spike:

```ts
import { buildPermissionAwareToolNode } from "@soa-harness/langgraph-adapter";
import { StateGraph, START, END, Annotation, messagesStateReducer } from "@langchain/langgraph";

const toolsNode = buildPermissionAwareToolNode({
  tools: myTools,
  hook: myPermissionHook, // { observe, decide }
});

const graph = new StateGraph(MessagesState)
  .addNode("tools", toolsNode)
  .addEdge(START, "tools")
  .addEdge("tools", END)
  .compile();
```

The wrapper (a) observes every `tool_call` name + args synchronously
before any dispatch, (b) partitions into approved / denied by calling
the hook, and (c) invokes the underlying `ToolNode` only with
approved calls. Denied calls synthesize `ToolMessage{status:"error"}`
and never reach the dispatcher.

See `test/compliance-wrapper.test.ts` for the temporal-ordering proof
(observation timestamp strictly precedes tool execution via
`process.hrtime.bigint()`).

## LangGraph version pin

Pinned to `@langchain/langgraph ~0.2.74` / `@langchain/core ^0.3.0` as
peer dependencies. Quarterly upgrade cadence: at each quarter boundary,
(a) bump the pin in `package.json`, (b) re-run the full conformance
suite against the new LangGraph version, (c) update §14.6 event
mapping in the spec if any events were added / renamed upstream.

## Declaring the adapter in the Agent Card

Per §18.5.1, the Agent Card MUST declare `host_framework`:

```json
{
  "adapter_notes": {
    "host_framework": "langgraph",
    "permission_mode": "pre-dispatch"
  }
}
```

The `HOST_FRAMEWORK` and `ADAPTER_VERSION` exports from this package
are the exact literal values to use.

## License

Apache-2.0.
