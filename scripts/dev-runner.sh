#!/usr/bin/env bash
# Repeatable :7700 Runner + :8001 Memory-MCP-Mock launcher.
#
# Usage:
#   scripts/dev-runner.sh start|stop|restart|status|logs|bounce
#
# Single source of truth for the env matrix the validator session polls
# against. Prior STATUS entries and the f54d618 HR-17 live-verify record
# the exact values this script uses — keep them in sync here, not buried
# in shell history.
#
# The script is idempotent: `start` on a healthy :7700 is a no-op; `stop`
# on a dead process is a no-op; `restart`/`bounce` does stop+start for
# post-shipment validator auto-flip per the plan cadence.

set -euo pipefail

# --- Repo + fixture paths ----------------------------------------------------
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
spec_root="$(cd "$repo_root/../soa-harness=specification" && pwd)"

runner_bin="$repo_root/packages/runner/dist/bin/start-runner.js"
mock_bin="$repo_root/tools/memory-mcp-mock/dist/bin/start-mock.js"

card_fixture="$spec_root/test-vectors/conformance-card/agent-card.json"
tools_fixture="$spec_root/test-vectors/tool-registry/tools.json"
# The 8-tool SV-PERM-01 matrix is the canonical live-:7700 fixture — covers
# every (risk_class, default_control) × (activeMode) combination. The M2
# compliant-only fixture is for SV-SESS-05 negative-path tests only and
# MUST NOT be the :7700 default (it has only 2 tools, so the validator's
# main permission sweep hits 404 unknown-tool on fs__*).
initial_trust="$spec_root/test-vectors/initial-trust/valid.json"
memory_corpus="$spec_root/test-vectors/memory-mcp-mock/corpus-seed.json"

logs_dir="$repo_root/logs"
runner_log="$logs_dir/runner.log"
mock_log="$logs_dir/memory-mcp-mock.log"
runner_pidfile="$logs_dir/runner.pid"
mock_pidfile="$logs_dir/memory-mcp-mock.pid"

mkdir -p "$logs_dir"

# --- Ports + bearers ---------------------------------------------------------
RUNNER_HOST="127.0.0.1"
RUNNER_PORT="7700"
MOCK_HOST="127.0.0.1"
MOCK_PORT="8001"

# Validator-agreed literals (see STATUS.md entries for L-21 + L-24 era).
# Do NOT rotate these mid-session without notifying the sibling validator.
BOOTSTRAP_BEARER="soa-conformance-week3-test-bearer"
DEMO_SESSION="ses_demoWeek3Conformance01:soa-conformance-week3-decide-bearer:DangerFullAccess"

# --- Helpers ----------------------------------------------------------------
log_info()  { printf "[dev-runner] %s\n" "$*"; }
log_error() { printf "[dev-runner] ERROR: %s\n" "$*" >&2; }

is_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_pidfile() {
  local f="$1"
  if [ -f "$f" ]; then
    cat "$f" 2>/dev/null || true
  fi
}

port_alive() {
  local host="$1" port="$2"
  curl -sS -m 2 "http://${host}:${port}/health" >/dev/null 2>&1
}

wait_for_port() {
  local host="$1" port="$2" timeout_s="${3:-15}"
  local i=0
  while [ "$i" -lt "$timeout_s" ]; do
    if port_alive "$host" "$port"; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

stop_by_pidfile() {
  local name="$1" pidfile="$2"
  local pid; pid="$(read_pidfile "$pidfile")"
  if is_pid_alive "$pid"; then
    log_info "stopping $name (pid $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if is_pid_alive "$pid"; then
      log_info "  still alive, SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pidfile"
}

verify_prereqs() {
  if [ ! -f "$runner_bin" ]; then
    log_error "Runner build missing at $runner_bin — run: pnpm -r build"
    exit 1
  fi
  if [ ! -f "$mock_bin" ]; then
    log_error "Memory-MCP-Mock build missing at $mock_bin — run: pnpm -r build"
    exit 1
  fi
  for f in "$card_fixture" "$tools_fixture" "$initial_trust"; do
    if [ ! -f "$f" ]; then
      log_error "Pinned fixture missing: $f (sibling spec repo at wrong commit?)"
      exit 1
    fi
  done
}

# --- Commands ---------------------------------------------------------------
cmd_start_mock() {
  local existing; existing="$(read_pidfile "$mock_pidfile")"
  if is_pid_alive "$existing" || port_alive "$MOCK_HOST" "$MOCK_PORT"; then
    log_info "memory-mcp-mock already up on ${MOCK_HOST}:${MOCK_PORT}"
    return 0
  fi
  log_info "starting memory-mcp-mock on ${MOCK_HOST}:${MOCK_PORT}"
  # Healthy-default mock: no timeout injection, no error injection,
  # pinned corpus seed. HR-17 tests override SOA_MEMORY_MCP_MOCK_TIMEOUT_AFTER_N_CALLS=0
  # via vitest; the long-running :7700 binary points here for happy-path prefetch.
  HOST="$MOCK_HOST" PORT="$MOCK_PORT" \
    SOA_MEMORY_MCP_MOCK_SEED="$memory_corpus" \
    nohup node "$mock_bin" > "$mock_log" 2>&1 &
  echo $! > "$mock_pidfile"
  if wait_for_port "$MOCK_HOST" "$MOCK_PORT" 10; then
    log_info "memory-mcp-mock up (pid $(cat "$mock_pidfile"))"
  else
    log_error "memory-mcp-mock failed to bind — check $mock_log"
    return 1
  fi
}

cmd_start_runner() {
  local existing; existing="$(read_pidfile "$runner_pidfile")"
  if is_pid_alive "$existing" || port_alive "$RUNNER_HOST" "$RUNNER_PORT"; then
    log_info "runner already up on ${RUNNER_HOST}:${RUNNER_PORT}"
    return 0
  fi
  log_info "starting runner on ${RUNNER_HOST}:${RUNNER_PORT}"

  # Env matrix — single source of truth. Comments cite the spec/plan line
  # that made the value load-bearing.
  RUNNER_HOST="$RUNNER_HOST" \
  RUNNER_PORT="$RUNNER_PORT" \
  RUNNER_CARD_FIXTURE="$card_fixture" \
  RUNNER_TOOLS_FIXTURE="$tools_fixture" \
  RUNNER_INITIAL_TRUST="$initial_trust" \
  RUNNER_SESSION_DIR="$repo_root/sessions" \
  SOA_RUNNER_BOOTSTRAP_BEARER="$BOOTSTRAP_BEARER" \
  RUNNER_DEMO_SESSION="$DEMO_SESSION" \
  SOA_RUNNER_MEMORY_MCP_ENDPOINT="http://${MOCK_HOST}:${MOCK_PORT}" \
  RUNNER_CRASH_TEST_MARKERS="0" \
  RUNNER_DEMO_MODE="1" \
  nohup node "$runner_bin" > "$runner_log" 2>&1 &
  echo $! > "$runner_pidfile"
  if wait_for_port "$RUNNER_HOST" "$RUNNER_PORT" 20; then
    log_info "runner up (pid $(cat "$runner_pidfile"))"
    curl -sS -m 2 "http://${RUNNER_HOST}:${RUNNER_PORT}/health" || true
    printf "\n"
  else
    log_error "runner failed to bind — tail $runner_log"
    tail -20 "$runner_log" >&2 || true
    return 1
  fi
}

cmd_start()   { verify_prereqs; cmd_start_mock; cmd_start_runner; }
cmd_stop()    { stop_by_pidfile "runner" "$runner_pidfile"; stop_by_pidfile "memory-mcp-mock" "$mock_pidfile"; }
cmd_restart() { cmd_stop; cmd_start; }
cmd_bounce()  { cmd_restart; }

cmd_status() {
  local r m; r="$(read_pidfile "$runner_pidfile")"; m="$(read_pidfile "$mock_pidfile")"
  printf "runner            pid=%-8s port-alive=%s\n" "${r:-none}" "$(port_alive "$RUNNER_HOST" "$RUNNER_PORT" && echo yes || echo no)"
  printf "memory-mcp-mock   pid=%-8s port-alive=%s\n" "${m:-none}" "$(port_alive "$MOCK_HOST" "$MOCK_PORT" && echo yes || echo no)"
}

cmd_logs() {
  echo "=== runner log (last 40) ==="
  [ -f "$runner_log" ] && tail -40 "$runner_log" || echo "(no log)"
  echo
  echo "=== memory-mcp-mock log (last 20) ==="
  [ -f "$mock_log" ] && tail -20 "$mock_log" || echo "(no log)"
}

# --- Dispatch ---------------------------------------------------------------
case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart|bounce) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  "")      log_error "usage: $0 {start|stop|restart|bounce|status|logs}"; exit 2 ;;
  *)       log_error "unknown command: $1"; exit 2 ;;
esac
