# AGENTS.md — demo agent project

This file is parsed at agent startup per SOA-Harness §7 and gives the agent its
long-term project rules. Replace the placeholders below with your own rules
before sharing this agent.

## Project scope

- Read and summarize files under `./workspace/`.
- Do not touch anything outside the project root.
- All mutating operations require operator Prompt approval.

## Permission preferences

- `fs__read_file` / `fs__list_directory` — AutoAllow (from `tools.json`).
- `fs__write_file` — Prompt (from `tools.json`; tighten via Agent Card
  `permissions.toolRequirements["fs__write_file"] = "Deny"` if you want to
  ban writes entirely for this deployment).

## Hook conventions

- `hooks/pre-tool-use.mjs` runs before every tool call; exit code ≠ 0 denies
  the call. Customize via the §15.3 exit-code grammar.

## Memory (§8)

- Disabled by default in this scaffold. Turn on via Agent Card
  `memory.enabled = true` and point `memory.mcp_endpoint` at a Memory MCP
  server.
