# Coordination — soa-harness-impl ↔ soa-validate ↔ soa-harness-specification

## The three-repo model

This implementation does not live alone. Three repos work together:

```
soa-harness-specification  (normative spec, source of truth)
        │ pinned-by ↓         ↓ pinned-by
soa-harness-impl (this)    soa-validate (Go conformance harness)
```

The spec defines what conformance means. This repo implements it. The validator independently checks. The whole architecture is designed to prevent self-proving: **the same author cannot author all three in a way that hides bugs**.

## How Claude Code sessions work across the three repos

Each repo can host its own Claude Code session. Sessions DO NOT share state, task lists, or working memory. What they share:

| Resource | Scope | How shared |
|---|---|---|
| `graphify-spec` MCP | User-level | Registered in `~/.claude.json`. Every session that opens (any repo) spawns its own local reader subprocess on demand. Reads spec's `graphify-out/graph.json` as a static file. **Nothing runs in the spec repo to enable this** — the MCP is stdio, stateless, spawned-per-session |
| `CodeGraphContext` MCP | Per-project | Each repo has its own FalkorDB code graph. No collision |
| `~/.claude/plans/` | User-level | Plan files visible to all sessions |
| Git history | Per-repo (via origin) | Each repo's git state is the durable record |
| `soa-validate.lock` | Per-repo | Pins this repo to a specific spec commit |
| `test-vectors/jcs-parity/` | Spec repo | Both this repo and soa-validate read from spec at pinned commit |

## When you're working in this repo, what's in the other sessions

- **Spec session**: may be authoring normative text, adding test IDs, rotating schema digests. **Any spec change that affects you will land in the spec repo first.** You notice by bumping `soa-validate.lock`.
- **Validate session**: writing Go conformance tests that run against a live version of this Runner. **Any contract change here (Runner HTTP API, StreamEvent payload) will break its tests unless you coordinate.**

## Change-propagation protocol

### You changed something implementation-only (bug fix, refactor, perf)
No coordination needed. Open PR, get review, merge.

### You changed the Runner's HTTP API, wire format, or any observable behavior
This is a **contract change**. The validate session tests the contract. Protocol:

1. Open a GitHub issue on THIS repo describing the change
2. Cross-reference in an issue on `soa-validate` — "FYI: <impl-repo-issue-url>, will affect <test IDs>"
3. Validate session updates its test expectations
4. Both PRs merge in lockstep (same day, ideally within minutes)

### You need a spec change (normative text, schema, test ID)
NEVER edit the spec repo from this session. Protocol:

1. Open a spec-repo issue describing the normative gap
2. Spec session authors the change (48-hour discussion window per GOVERNANCE.md)
3. Spec merges, commit SHA updates
4. You bump `soa-validate.lock` in THIS repo to the new spec commit (separate PR)
5. Validate bumps its own `soa-validate.lock` simultaneously

### The spec changed something that affects you
Spec session will open a GitHub issue on this repo announcing: "Spec commit <sha> affects <your component>. Please bump `soa-validate.lock`." You review the delta, bump the lock, update impl code as needed.

## The MCP connection model (simple version)

- `graphify-spec` is a stdio subprocess, NOT a network service
- Each Claude Code session spawns its own copy on demand
- The subprocess reads `graphify-out/graph.json` from the spec repo on disk
- When the spec repo commits, a git hook refreshes `graph.json`
- Your next graphify query sees the fresh data — **no restart needed, no coordination needed**

**The spec repo does not need to be "open" in Claude Code for you to query its graph.** The file on disk is enough.

**If you move the spec repo to a different folder, both this session and sibling sessions break until `claude mcp remove`/`add` updates the path in `~/.claude.json`.**

## Running multiple Claude Code sessions safely

```powershell
# Terminal 1 — implementation work
cd C:\Users\wbrumbalow\Documents\Projects\soa-harness-impl
claude

# Terminal 2 (separate) — validator work
cd C:\Users\wbrumbalow\Documents\Projects\soa-validate
claude

# Terminal 3 (optional, when spec needs editing) — spec work
cd "C:\Users\wbrumbalow\Documents\Projects\soa-harness=specification"
claude
```

All three can run concurrently. Each has its own context, memory, and task list. Nothing is "shared in memory"; everything shared lives as files in git.

## Signaling between sessions

Two options, in order of preference:

1. **GitHub issues/PRs** — durable, reviewable, linkable. Preferred for anything that affects merged code or API contracts.
2. **`STATUS.md` at the top of each repo** — cheap scratchpad for "working on X right now, please don't touch" style signals. Commit it, push it, the other session sees it on next `git pull`. Deletes when the signal is no longer relevant.

## Anti-patterns

- ❌ Editing the spec repo from an impl session
- ❌ Silently bumping `soa-validate.lock` without announcing to the validate session
- ❌ Landing contract changes in impl and validate on different spec commits
- ❌ Treating sibling sessions as if they can read each other's task lists (they cannot)
- ❌ Running parallel sessions ON THE SAME REPO (different story — Claude Code isn't designed for that)
