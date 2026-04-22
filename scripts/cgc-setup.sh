#!/usr/bin/env bash
# One-time setup for this checkout's CodeGraphContext integration.
#
#   1. Wire the versioned post-commit hook via core.hooksPath.
#   2. Run an initial index so queries have fresh data.
#
# Re-running is safe: git config writes are idempotent; cgc index
# deduplicates against already-indexed files.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# 1. Point git at the versioned hook directory (per-checkout, not global).
git config --local core.hooksPath scripts/hooks
echo "[cgc-setup] core.hooksPath = scripts/hooks"

# 2. Mark the hook executable (Windows git-bash sometimes drops +x).
chmod +x scripts/hooks/post-commit 2>/dev/null || true

# 3. Locate cgc and kick an initial index.
cgc_bin="cgc"
if ! command -v cgc >/dev/null 2>&1; then
  if [ -x "$HOME/AppData/Local/Programs/Python/Python312/Scripts/cgc.EXE" ]; then
    cgc_bin="$HOME/AppData/Local/Programs/Python/Python312/Scripts/cgc.EXE"
  else
    echo "[cgc-setup] WARNING: cgc not found on PATH; skipping initial index." >&2
    echo "[cgc-setup] Install CodeGraphContext (pip install codegraphcontext) then re-run this script." >&2
    exit 0
  fi
fi

mkdir -p logs
echo "[cgc-setup] starting initial index (output to logs/cgc-index.log)"
PYTHONIOENCODING=utf-8 "$cgc_bin" index . > logs/cgc-index.log 2>&1 || true
echo "[cgc-setup] done. Verify with: PYTHONIOENCODING=utf-8 cgc stats"
