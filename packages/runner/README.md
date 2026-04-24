# @soa-harness/runner

SOA-Harness Runner — HTTP surface, trust bootstrap, Agent Card,
StreamEvents, permission resolver, attestation, audit, probes.

## What it implements

Core profile of
[SOA-Harness](https://github.com/wleeb1010/soa-harness-specification)
v1.0. Exposes the normative `/.well-known/agent-card.json`,
`/.well-known/agent-card.jws`, `/health`, `/ready`, `/audit/tail`,
`/audit/records`, `/permissions/resolve`, `/permissions/decisions`,
plus the M3-era observability endpoints (`/memory/state/:sid`,
`/budget/projection`, `/tools/registered`, `/events/recent`,
`/observability/otel-spans/recent`, `/observability/backpressure`,
`/logs/system/recent`, `/sessions/:id/state`, `/audit/sink-events`).

Normative features:
- §5 Required Stack + §5.3 External Bootstrap Root
- §6 Agent Card + §7 Card Precedence
- §10.3 Permission Decision flow + §10.3.2 pda-malformed / pda-verify-unavailable
- §10.4 Handler Roles + §10.4.1 Autonomous→Interactive escalation
- §10.5 Audit Chain (WORM sink mode, retention_class, reader-token scope)
- §10.6 Handler Key Lifecycle (enroll, CRL poller, key-storage, SuspectDecision)
- §11 Tool Registry + §11.3.1 dynamic test hook + §11.4 registered listing
- §12 Session persistence + §12.5.3 crash-marker protocol + §12.6 resume paths
- §13 Token Budget (M3 scope)
- §14 StreamEvent (27-enum, §14.1.1 payloads, §14.5 observability endpoints)
- §14.2 System Event Log + `/logs/system/recent`
- §15 Hooks pipeline
- §19.4 errata: v1.0 includes all §X.Y Observability additions pinned
  in `MANIFEST.supplementary_artifacts` at release time.

The spec pin is in the monorepo's `soa-validate.lock` —
`spec_commit_sha` is authoritative for exactly which schemas,
fixtures, and normative sections this binary ships against.

## Running

See [`create-soa-agent`](https://www.npmjs.com/package/create-soa-agent) for
the fastest start — it scaffolds a working Runner + Agent Card + tool
registry + illustrative hook in one command.

The programmatic API exports `startRunner`, `loadInitialTrust`,
`BootOrchestrator`, `AuditChain`, `loadToolRegistry`, `CrlCache`,
`InMemorySessionStore`, `generateEd25519KeyPair`, and friends.

## LLM Dispatcher (§16.3, v1.1+)

The Runner includes an LLM dispatcher wrapping provider-specific adapters.
Adopter's job: implement `ProviderAdapter` for their chosen LLM; the
dispatcher handles budget pre-check, billing-tag propagation, cancellation,
retry budget, error classification, and audit.

Minimal wiring:

```typescript
import { buildRunnerApp, Dispatcher, BudgetTracker, AuditChain } from "@soa-harness/runner";
import { ExampleProviderAdapter } from "@soa-harness/example-provider-adapter";

const adapter = new ExampleProviderAdapter({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  name: "openai",
});

const dispatcher = new Dispatcher({
  adapter,
  budgetTracker: new BudgetTracker(),
  auditChain: new AuditChain(() => new Date()),
  clock: () => new Date(),
  runnerVersion: "1.1",
});

const app = await buildRunnerApp({
  // ... other opts
  dispatch: {
    dispatcher,
    sessionStore,
    clock: () => new Date(),
    runnerVersion: "1.1",
    bootstrapBearer: process.env.SOA_OPERATOR_BEARER, // optional — unlocks admin on /dispatch/recent
  },
});
```

Exposes:
- `POST /dispatch` — fire one dispatch; session-bearer auth; schema-validated
- `GET /dispatch/recent` — observability ring buffer; newest-first; session or admin bearer

For a real-provider scaffold showing request shaping + error classification
+ abort-signal handling, see `@soa-harness/example-provider-adapter`.

For conformance-probe fault injection (the `InMemoryTestAdapter` DSL), set
`SOA_DISPATCH_ADAPTER=test-double + SOA_DISPATCH_TEST_DOUBLE_CONFIRM=1` at
Runner boot. The dispatcher auto-registers in test-double mode and exposes
`POST /dispatch/debug/set-behavior` (admin-only).

See Core spec §16.3 / §16.3.1 / §16.4 / §16.5 for the normative contract
and `SV-LLM-01..07` for the conformance probes.

## Conformance

Validate against the Go [`soa-validate`](https://github.com/wleeb1010/soa-validate)
harness:

```
soa-validate --agent-url http://localhost:7700 --profile core
```

For the scaffolded-agent flow: `npm run conform` inside a project produced
by `create-soa-agent` auto-runs the validator.

To sanity-check validator-vs-Runner pin alignment before the full suite:

```
soa-validate --check-pins --impl-url http://localhost:7700
```

## License

Apache-2.0.
