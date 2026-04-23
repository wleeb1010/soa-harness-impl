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

## Conformance

Validate against the Go [`soa-validate`](https://github.com/wleeb1010/soa-validate)
harness:

```
soa-validate --agent-url http://localhost:7700 --profile core
```

## License

Apache-2.0.
