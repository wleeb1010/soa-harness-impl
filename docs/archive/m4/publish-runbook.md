# Publish Runbook — SOA-Harness npm Packages

Recipe for publishing `@soa-harness/*` scoped packages and `create-soa-agent` to npm under the `next` dist-tag. Validated against the M4 Phase 0e E3 sweep (2026-04-22, initial v1.0.0-rc.0 / rc.1 publishes). Re-use for every future RC and the v1.0.0 final release.

## Pre-publish checklist (per package)

1. **Working tree clean.** `git status` must show zero uncommitted changes.
   - `.claude/` is local Claude Code state — confirm it's in `.gitignore`.
   - `pnpm publish` refuses unclean trees by default (good; do not pass `--no-git-checks`).

2. **Build clean.** `pnpm -r build` green across the whole monorepo.

3. **Tests green.** `pnpm -r test` green. Non-negotiable — the tests are the correctness contract we're publishing.

4. **Version bumped.** `package.json` version field reflects what we're about to publish:
   - `1.0.0-rc.N+1` for next prerelease iteration
   - `1.0.0` for final release
   - Do NOT republish the same version — npm rejects duplicate version publishes.

5. **publishConfig correct.** Each publishable has:
   ```json
   "publishConfig": {
     "access": "public",
     "tag": "next"
   }
   ```
   Rely on this; do NOT pass `--tag next` on the CLI (typo risk — one missed letter and the package goes to `nex` or `latest`).

6. **Tarball audit.** Before the real publish:
   ```bash
   pnpm pack
   tar -tzf soa-harness-<pkg>-<version>.tgz | sort
   ```
   Verify:
   - `LICENSE` and `README.md` present at tarball root
   - `dist/` content included
   - Absent: `node_modules`, `.git`, `.github`, `scripts`, `test`, `coverage`, `logs`, `sessions`, `.claude`, `.env*`, `*.pem`, `*.key`, `*.jwk`, `id_rsa*`, `id_ed25519*`, `.tsbuildinfo`
   - Secret scan:
     ```bash
     tar -xzf soa-harness-<pkg>-<version>.tgz -C /tmp/audit/
     grep -rIl "PRIVATE KEY\|BEGIN RSA\|BEGIN EC\|-----BEGIN" /tmp/audit/
     ```
     False positives for code that manipulates PEM strings are OK; real PEM blocks are NOT.

7. **Workspace auto-rewrite verified.** After `pnpm pack`, extract and inspect `package.json`:
   ```bash
   tar -xOzf soa-harness-<pkg>-<version>.tgz package/package.json | grep -E "workspace|@soa-harness"
   ```
   No `workspace:*` protocol refs should appear. `pnpm publish` rewrites them to the real version; if you see `workspace:*` in the packed manifest, DO NOT publish — fix the config first.

## Publish sequence (4-package sweep)

From the impl repo root, using a shell with `npm login` active and 2FA configured on `auth-and-writes`:

```bash
(cd packages/core              && pnpm publish)
(cd packages/schemas           && pnpm publish)
(cd packages/runner            && pnpm publish)
(cd packages/create-soa-agent  && pnpm publish)
```

Subshell parentheses (or matching PowerShell: `Push-Location` / `Pop-Location`) keep the working directory clean between steps. Each `pnpm publish` prompts for an OTP from your authenticator — enter it.

For the `@soa-harness/langgraph-adapter` package (shipping at M4 exit):

```bash
(cd packages/langgraph-adapter && pnpm publish)
```

For M5 memory backends:

```bash
(cd packages/memory-mcp-sqlite && pnpm publish)
(cd packages/memory-mcp-mem0   && pnpm publish)
(cd packages/memory-mcp-zep    && pnpm publish)
```

## Post-publish verification (per package)

**Version endpoint is authoritative. Packument endpoint lags.**

The registry's packument endpoint (`/@soa-harness/<pkg>`) aggregates versions and takes minutes to sync for fresh packages. The version-specific endpoint (`/@soa-harness/<pkg>/<version>`) is authoritative immediately. Probe the version endpoint first:

```bash
curl -sSL -w "HTTP:%{http_code}\n" -o /dev/null \
  https://registry.npmjs.org/@soa-harness/<pkg>/<version>
```

Expect HTTP 200. If 404: publish did not land — stop, investigate, do not advance.

**Dist-tag state.** Confirm the tag applied correctly:

```bash
curl -sSL https://registry.npmjs.org/-/package/@soa-harness/<pkg>/dist-tags
```

Expected shapes:
- First publish of a package: `{"next": "<version>", "latest": "<version>"}` — npm auto-sets `latest` on first publish of any package; cannot be prevented
- Subsequent RC publishes: `{"next": "<new-version>", "latest": "<original-first-version>"}` — `latest` stays pinned at whatever the first publish set it to, unless we move it explicitly

**If dist-tag is wrong** (e.g., typo `nex` instead of `next`):

```bash
npm dist-tag add @soa-harness/<pkg>@<version> next
npm dist-tag rm  @soa-harness/<pkg> nex
```

## End-to-end verification (after full sweep)

This is the **real gate** — more important than any individual publish verification. Run from a temp directory, not inside the monorepo:

```powershell
# PowerShell
cd $env:TEMP
if (Test-Path soa-publish-test) { Remove-Item -Recurse -Force soa-publish-test }
mkdir soa-publish-test | Out-Null
cd soa-publish-test
npx create-soa-agent@next publish-test
cd publish-test
npm install
$env:PORT = "7710"
node ./start.mjs
```

Expected:
- Scaffold runs, prints warning about synthetic self-signed keypair (demo only)
- `npm install` completes with `0 vulnerabilities`, `workspace:` errors absent
- `node start.mjs` prints `[demo] first audit row produced: aud_<hex>` + `[demo] Runner live at http://127.0.0.1:<port>`

Probe the Runner from a second shell:

```bash
curl -s http://127.0.0.1:7710/health                                # {"status":"alive","soaHarnessVersion":"1.0"}
curl -s http://127.0.0.1:7710/ready                                 # {"status":"ready"}
curl -s http://127.0.0.1:7710/.well-known/agent-card.json | head -c 200
curl -s -o /dev/null -w "%{http_code} bytes:%{size_download}\n" \
  http://127.0.0.1:7710/.well-known/agent-card.jws                  # 200 bytes:~700
```

If any of these fail, **the publish is not shippable even if every package landed**. Diagnose from the failing endpoint back to the underlying package — usually a missing public export or a template dep misalignment.

## Rollback

**Within 72h of publish:**

```bash
npm unpublish @soa-harness/<pkg>@<version> --force
```

**After 72h** (unpublish denied):

```bash
npm deprecate @soa-harness/<pkg>@<version> "<reason>"
```

Deprecated versions stay in the registry but emit a warning on install. Combine with advancing a dist-tag off the deprecated version:

```bash
npm dist-tag add @soa-harness/<pkg>@<replacement-version> next
```

For `create-soa-agent` specifically, also update `latest` if needed so `npm install create-soa-agent` (no tag) pulls the working version:

```bash
npm dist-tag add create-soa-agent@<replacement-version> latest
```

## Known gotchas

1. **`pnpm publish` CLI `--tag` overrides `publishConfig.tag`.** A typo in `--tag` corrupts the dist-tag. Solution: omit the flag, rely on `publishConfig.tag` in package.json.

2. **First-publish auto-sets `latest`.** npm always points `latest` at the first published version of any package. There's no flag to prevent this. Live with it; future RCs advance only `next`, leaving `latest` pinned at rc.0 until we explicitly move it at M6.

3. **Packument lag is real.** `npm install` resolving a dep range like `^1.0.0-rc.0` hits the packument endpoint, not the version endpoint. Packument sync for fresh packages can take 2-5 minutes, longer for larger packages (runner's 435-file packument took ~3 minutes). If install fails with 404 on a package you just published, wait and retry.

4. **Missing public exports only surface at fresh install.** Monorepo dev paths resolve internal imports across the workspace — so a symbol exported from `src/foo/index.ts` but not re-exported from the package's top-level `src/index.ts` works fine in monorepo tests but fails for external consumers. The only reliable detection is the fresh-install-plus-boot test above. Make it mandatory for every publish sweep.

5. **`.claude/` directory** (Claude Code local state) must be in `.gitignore` across all three repos — it surfaces as an unclean working tree and blocks `pnpm publish`.

6. **Windows line-endings (LF→CRLF warnings).** Benign. Git auto-handles per `.gitattributes`; pnpm-published tarballs are normalized.

## Version-bump discipline

Each RC increments:
- `1.0.0-rc.0` → `1.0.0-rc.1` → `1.0.0-rc.2` → ... → `1.0.0` (final)

Do NOT republish the same version, ever. If an RC needs a fix, bump to the next RC number and republish, deprecating the broken version. Version numbers are immutable once on the registry.

At M6 v1.0.0 final tag:

```bash
# After publishing 1.0.0:
npm dist-tag add @soa-harness/<pkg>@1.0.0 latest
npm dist-tag rm  @soa-harness/<pkg> next            # optional: retire next tag
```

This makes `npm install @soa-harness/<pkg>` (default `latest`) resolve to the final release.
