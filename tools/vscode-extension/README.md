# soa-harness-vscode

VS Code support for SOA-Harness v1.2. **Stub-level.** Full IDE integration is M9+.

## What it does

- Reads `.soa/config.json` in the workspace root for `runnerUrl` + `sessionBearer`. Falls back to `soaHarness.runnerUrl` / `soaHarness.sessionBearer` user settings.
- Renders a **SOA Runner** tree view in the Explorer sidebar showing `/health`, `/ready`, and `/version` (including `spec_commit_sha` on v1.1.1+).
- Command **SOA-Harness: Dispatch from Editor** — prompts for a session ID + a prompt (prefilled from the current text selection), fires a synchronous `POST /dispatch`, opens the result as a scratch JSON doc.
- Command **SOA-Harness: Tail Audit Log** — opens a terminal with `SOA_RUNNER_URL` + `SOA_SESSION_BEARER` set and runs `soa audit tail` (requires `@soa-harness/cli` globally installed).
- Auto-refreshes the status tree every 5s (configurable via `soaHarness.autoRefreshMs`, 0 disables).

## Install

Not on the marketplace yet. For local dev:

```bash
cd tools/vscode-extension
pnpm install
pnpm build
# In VS Code: Extensions view → "Install from VSIX…" or F5 to launch an
# Extension Development Host.
```

`.vsix` packaging + marketplace publish is v1.2.x work per L-63 scope.

## Workspace config format

`.soa/config.json`:

```json
{
  "runnerUrl": "http://127.0.0.1:7700",
  "sessionBearer": "<bearer-from-POST-/sessions>"
}
```

Keeping the bearer in a workspace file (rather than user settings) lets adopters rotate it alongside their dev loop without touching VS Code globals — and lets `.soa/` be `.gitignore`d.

## Scope deliberately held at "stub"

- No streaming dispatch — the dispatch command uses `stream: false` for v1.2. Streaming-into-editor experience is targeted for a v1.2.x patch after adoption signal.
- No multi-root workspace handling (reads first folder only).
- No language-server features.
- No per-file Runner-status decorations.
- No .vsix bundling / marketplace publish in this repo (separate tooling, v1.2.x).

All additive; the v1.2 wire contract stays unchanged as these ship.
