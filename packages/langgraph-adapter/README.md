# @soa-harness/langgraph-adapter

SOA-Harness adapter for LangGraph.js. Wraps an existing LangGraph
`StateGraph` so the resulting runtime satisfies §18.5 Adapter
Conformance (Core profile) without forcing you to rewrite your agent
against a native SOA Runner.

## Status

**Phase 2.7 — demo binary shipped. SV-ADAPTER probes run end-to-end.**

- ✅ Pre-dispatch permission interception (`buildPermissionAwareToolNode`)
- ✅ HTTP permission hook (`RunnerBackedPermissionHook`, `POST /permissions/decisions`)
- ✅ StreamEvent synthesis (§14.6 direct-mapping, 14 LangGraph → 12 SOA types)
- ✅ Audit-sink forwarding with retention_class stamping (§10.5.6)
- ✅ `SV-ADAPTER-01..04` end-to-end over real HTTP
- ✅ `soa-langgraph-adapter-demo` binary (Phase 2.7)

## Demo binary

The package ships a self-contained `soa-langgraph-adapter-demo` CLI that
stands up the two-Runner composition (a minimal back-end Runner on an
internal random port + the adapter server on `PORT`) suitable for
`soa-validate --adapter=langgraph` probing:

```
npx -p @soa-harness/langgraph-adapter@next soa-langgraph-adapter-demo
```

Environment variables:

- `PORT` — adapter listen port (default `7701`)
- `HOST` — bind host (default `127.0.0.1`)
- `ADAPTER_SESSION_ID` — session id for the default registered session
  (must match `/^ses_[A-Za-z0-9]{16,}$/`)
- `ADAPTER_SESSION_BEARER` — bearer for the default session
- `ADAPTER_ACTIVE_MODE` — `ReadOnly` | `WorkspaceWrite` | `DangerFullAccess`
  (drives retention_class stamping)

Shutdown: `SIGINT` / `SIGTERM` gracefully closes both servers.

See `templates/demo-stategraph.mjs` for a minimal one-tool LangGraph
StateGraph wired through the adapter's permission-aware ToolNode.

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
