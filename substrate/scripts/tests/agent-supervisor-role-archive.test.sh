#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC2317
# (SC2317 false positive: test functions are called indirectly via run_test; static analysis cannot trace this)
#
# Test driver for the supervisor's part of a role archive in agent-supervisor.sh:
# finish_archiving_roles() (the role's folder follows its claimed agents into the
# archive; a collision is written into the claim) and the failure bookkeeping of
# finish_archiving_identities().
#
# Exits 0 on all-pass; exits 1 on any failure with a diagnostic naming the failing test.
#
# Usage: bash substrate/scripts/tests/agent-supervisor-role-archive.test.sh
#   Run from the repo root. Override supervisor path:
#   SUPERVISOR=/path/to/agent-supervisor.sh bash substrate/scripts/tests/agent-supervisor-role-archive.test.sh
#
# Requirements: bash, shellcheck, tmux, jq, stat, curl (mandatory — same as the supervisor).
#   python3 (mandatory for stub-homeserver-backed retire_identity calls; tests
#   using retire_identity skip gracefully if python3 is unavailable).
#
# Isolation: every test that sources the supervisor exports:
#   AGENT_IDENTITIES_DIR=<scratch>              — points IDENTITIES_DIR at scratch
#   AGENT_IDENTITIES_ARCHIVE_DIR=<scratch>-archive — points IDENTITIES_ARCHIVE_DIR at sibling
#   AGENT_ROLES_DIR=<scratch>-roles             — points ROLES_DIR at sibling (Phase 133)
#   AGENT_ROLES_ARCHIVE_DIR=<scratch>-roles-archive — points ROLES_ARCHIVE_DIR at sibling
#   AGENT_SUPERVISOR_LIB_ONLY=1                 — stops before the reconcile loop
#
# TODO: the harness (helpers + fixture_identity + start_stub_homeserver + assertion macros)
# is duplicated from agent-supervisor-archive-scan.sh — a future phase could extract to
# substrate/scripts/tests/lib/test-harness.sh. Kept inline here for scope-tight execution
# (the sibling file is stable and the duplication is bounded ~300 lines).

export AGENT_SUPERVISOR_LIB_ONLY=1

set -u  # -e is NOT set — the script uses explicit assert helpers so a failing
        # assert does not silently skip subsequent tests.

# ---- path resolution ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SUPERVISOR="${SUPERVISOR:-$REPO_ROOT/substrate/scripts/agent-supervisor.sh}"

if [ ! -f "$SUPERVISOR" ]; then
  printf 'FATAL: supervisor not found at %s\n' "$SUPERVISOR" >&2
  exit 1
fi

# ---- tool availability checks ----
MISSING_MANDATORY=""
for _tool in shellcheck tmux jq curl stat; do
  command -v "$_tool" >/dev/null 2>&1 || MISSING_MANDATORY="$MISSING_MANDATORY $_tool"
done
if [ -n "$MISSING_MANDATORY" ]; then
  printf 'FATAL: mandatory tools missing (same as supervisor requirements):%s\n' "$MISSING_MANDATORY" >&2
  exit 1
fi

HAS_PYTHON3=false
command -v python3 >/dev/null 2>&1 && HAS_PYTHON3=true
HAS_STUB_SERVER=false
$HAS_PYTHON3 && HAS_STUB_SERVER=true

# ---- hermetic source invocation ----
# Sources the supervisor with all Phase 133 role-archive env vars pointing at scratch dirs
# (siblings, not subdirs — mirrors the identity-archive pattern from the Phase 94-04 tests).
_source_supervisor_with_roles() {
  local scratch="${1:-/tmp}"
  export AGENT_IDENTITIES_DIR="$scratch"
  export AGENT_IDENTITIES_ARCHIVE_DIR="${scratch}-archive"
  export AGENT_ROLES_DIR="${scratch}-roles"
  export AGENT_ROLES_ARCHIVE_DIR="${scratch}-roles-archive"
  export DORMANCY_STATE_DIR="$scratch/.state"
  export AGENT_SUPERVISOR_LIB_ONLY=1
  # shellcheck disable=SC1090  # dynamic path
  source "$SUPERVISOR" 2>/dev/null || true
}

# ---- test state ----
PASS=0
FAIL=0
FAILURES=()

# ---- helpers ----
fail() {
  local msg="${1:-unknown failure}"
  FAILURES+=("${CURRENT_TEST:-unknown}: $msg")
  FAIL=$((FAIL + 1))
}

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-assert_eq}"
  if [ "$expected" != "$actual" ]; then
    fail "$msg: expected='$expected' got='$actual'"
  fi
}

assert_file() {
  local path="$1" msg="${2:-assert_file}"
  if [ ! -e "$path" ]; then
    fail "$msg: expected file/dir '$path' to exist"
  fi
}

assert_nofile() {
  local path="$1" msg="${2:-assert_nofile}"
  if [ -e "$path" ]; then
    fail "$msg: expected '$path' to NOT exist, but it does"
  fi
}

assert_grep() {
  local pattern="$1" text="$2" msg="${3:-assert_grep}"
  if ! printf '%s' "$text" | grep -q "$pattern" 2>/dev/null; then
    fail "$msg: pattern '$pattern' not found in output"
  fi
}

assert_nogrep() {
  local pattern="$1" text="$2" msg="${3:-assert_nogrep}"
  if printf '%s' "$text" | grep -q "$pattern" 2>/dev/null; then
    fail "$msg: pattern '$pattern' unexpectedly found in output"
  fi
}

# setup_role_scratch: create mktemp -d for identities scratch and siblings for identity-archive,
# roles, and roles-archive. Returns the identities scratch path. teardown_role_scratch cleans up all four.
setup_role_scratch() {
  local s; s=$(mktemp -d)
  mkdir -p "$s/.state" "${s}-archive" "${s}-roles" "${s}-roles-archive"
  printf '%s' "$s"
}

teardown_role_scratch() {
  local s="$1"
  [ -n "$s" ] && [ -d "$s" ] && rm -rf "$s"
  [ -n "$s" ] && [ -d "${s}-archive" ] && rm -rf "${s}-archive"
  [ -n "$s" ] && [ -d "${s}-roles" ] && rm -rf "${s}-roles"
  [ -n "$s" ] && [ -d "${s}-roles-archive" ] && rm -rf "${s}-roles-archive"
}

# fixture_identity: create an identity folder <scratch>/<name>/ with a <name>.md carrying the
# requested role in its frontmatter (default roles: test, matching the sibling harness).
# Usage: fixture_identity <scratch> <name> [--role <role_name>] [--pinned] [--no-dormancy] [--coordinator]
fixture_identity() {
  local scratch="$1" name="$2"
  shift 2
  local role="test"
  local pinned=false nodormancy=false coordinator=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --role)         role="$2"; shift ;;
      --pinned)       pinned=true ;;
      --no-dormancy)  nodormancy=true ;;
      --coordinator)  coordinator=true ;;
    esac
    shift
  done
  local iddir="$scratch/$name"
  mkdir -p "$iddir"
  if $coordinator; then
    printf -- '---\nroles: %s\ncoordinator: true\n---\nbody\n' "$role" > "$iddir/$name.md"
  else
    printf -- '---\nroles: %s\n---\nbody\n' "$role" > "$iddir/$name.md"
  fi
  $pinned     && touch "$iddir/.pinned"
  $nodormancy && touch "$iddir/.no-dormancy"
}

# fixture_relay_json: write relay.json for an identity at <dir>.
fixture_relay_json() {
  local dir="$1" base="$2" mxid="$3" password="$4" token="$5"
  jq -n \
    --arg base       "$base" \
    --arg user_id    "$mxid" \
    --arg password   "$password" \
    --arg access_token "$token" \
    '{"base":$base,"user_id":$user_id,"password":$password,"access_token":$access_token,"token":$access_token}' \
    > "$dir/relay.json"
}

# fixture_role_folder: create a role folder under $scratch-roles/, optionally with the
# .archive-requested sentinel present.
# Usage: fixture_role_folder <scratch> <role_name> [--with-sentinel]
fixture_role_folder() {
  local scratch="$1" role_name="$2"
  shift 2
  local with_sentinel=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --with-sentinel) with_sentinel=true ;;
    esac
    shift
  done
  local role_dir="${scratch}-roles/$role_name"
  mkdir -p "$role_dir"
  # Drop a marker file so the folder actually contains something (roles typically have
  # a role.md or similar; the exact content is irrelevant to the archive gesture per D-17).
  printf 'role-content-marker\n' > "$role_dir/role.md"
  if $with_sentinel; then
    touch "$role_dir/.archive-requested"
  fi
}

# ---- stub homeserver ----
STUB_PID=""
STUB_PORT=""
STUB_LOG=""
STUB_REQ_LOG=""

# start_stub_homeserver: same shape as the sibling harness (single-code OR comma-sequence).
start_stub_homeserver() {
  local http_code="$1"
  STUB_PID=""
  STUB_PORT=""
  STUB_LOG=$(mktemp)
  STUB_REQ_LOG=$(mktemp)

  if $HAS_PYTHON3; then
    python3 -c "
import http.server, sys, socketserver

codes = [int(c) for c in sys.argv[1].split(',')]
port_file = sys.argv[2]
req_log = sys.argv[3]
counter = {'i': 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length > 0 else b''
        with open(req_log, 'ab') as f:
            f.write(('%s %d ' % (self.path, length)).encode('utf-8'))
            f.write(body.replace(b'\n', b' '))
            f.write(b'\n')
        idx = min(counter['i'], len(codes) - 1)
        counter['i'] += 1
        code = codes[idx]
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"status\":\"ok\"}\n')
    def log_message(self, fmt, *args): pass

with socketserver.TCPServer(('127.0.0.1', 0), Handler) as server:
    port = server.server_address[1]
    with open(port_file, 'w') as f:
        f.write(str(port))
    server.serve_forever()
" "$http_code" "$STUB_LOG" "$STUB_REQ_LOG" &
    STUB_PID=$!

    # Wait for server to write its port (up to 5s)
    local waited=0
    while [ "$waited" -lt 50 ] && [ ! -s "$STUB_LOG" ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if [ ! -s "$STUB_LOG" ]; then
      fail "start_stub_homeserver: python3 stub did not write port within 5s"
      return 1
    fi
    STUB_PORT=$(cat "$STUB_LOG")
    return 0
  else
    fail "start_stub_homeserver: python3 not available"
    return 1
  fi
}

stop_stub_homeserver() {
  if [ -n "$STUB_PID" ]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
    STUB_PID=""
  fi
  [ -n "$STUB_LOG" ] && rm -f "$STUB_LOG"
  STUB_LOG=""
  [ -n "$STUB_REQ_LOG" ] && rm -f "$STUB_REQ_LOG"
  STUB_REQ_LOG=""
  STUB_PORT=""
}

# ---- run_test wrapper ----
run_test() {
  local test_fn="$1"
  local before_fail=$FAIL
  CURRENT_TEST="$test_fn"

  stop_stub_homeserver 2>/dev/null || true
  "$test_fn"

  if [ "$FAIL" -eq "$before_fail" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$test_fn"
  else
    printf 'FAIL  %s\n' "$test_fn"
  fi
}

# ---- shared preamble ----
_stub_preamble() {
  if ! $HAS_STUB_SERVER; then
    printf '  SKIPPED (stub homeserver requires python3)\n'
    return 1
  fi
  return 0
}

# ============================================================
# finish_archiving_roles — a claimed role's folder follows its agents into the archive
# ============================================================
# The front door's role-archive claims the role (.archiving listing the agents it took) and
# each of those agents (fleet-change.test.sh covers that). Here: the supervisor's part.

# claim_role <scratch> <role> <agent...>: the role as the front door leaves it.
claim_role() {
  local scratch="$1" role="$2"; shift 2
  fixture_role_folder "$scratch" "$role"
  printf '%s\n' "$@" | jq -Rnc --arg id r1 '{id: $id, by: "user", agents: [inputs | select(. != "")]}' \
    > "${scratch}-roles/$role/.archiving"
}

# Test A — the role and both its agents, end to end in one pass.
test_role_and_its_agents_finish_in_one_pass() {
  _stub_preamble || { PASS=$((PASS + 1)); return; }
  local scratch; scratch=$(setup_role_scratch)
  local role="box-maintainer"
  claim_role "$scratch" "$role" alpha beta
  fixture_identity "$scratch" alpha --role "$role"; : > "$scratch/alpha/.archiving"
  fixture_identity "$scratch" beta  --role "$role"; : > "$scratch/beta/.archiving"
  fixture_identity "$scratch" gamma --role "other"
  fixture_relay_json "$scratch/alpha" "http://127.0.0.1:STUB_PORT/_matrix/client/v3" "@alpha:test" "pw" "tok"
  fixture_relay_json "$scratch/beta"  "http://127.0.0.1:STUB_PORT/_matrix/client/v3" "@beta:test"  "pw" "tok"
  start_stub_homeserver 200 || { teardown_role_scratch "$scratch"; return; }
  sed -i "s|STUB_PORT|$STUB_PORT|" "$scratch/alpha/relay.json" "$scratch/beta/relay.json"

  local out
  out=$( _source_supervisor_with_roles "$scratch"
         finish_archiving_identities; finish_archiving_roles 2>&1 ) || true
  stop_stub_homeserver

  assert_file   "${scratch}-archive/alpha" "alpha archived"
  assert_file   "${scratch}-archive/beta"  "beta archived"
  assert_nofile "${scratch}-archive/alpha/.archiving" "alpha's claim cleared in the archive"
  assert_file   "$scratch/gamma" "an agent the claim didn't take stays"
  assert_nofile "${scratch}-roles/$role" "role folder gone from the live tree"
  assert_file   "${scratch}-roles-archive/$role/role.md" "role folder in the archive"
  assert_nofile "${scratch}-roles-archive/$role/.archiving" "role claim cleared in the archive"
  assert_grep "role '$role' archive finished" "$out" "completion log line"
  teardown_role_scratch "$scratch"
}

# Test B — the role waits while one of its agents is still being finished.
test_role_waits_for_its_agents() {
  local scratch; scratch=$(setup_role_scratch)
  claim_role "$scratch" eng alpha beta
  fixture_identity "$scratch" alpha --role eng; : > "$scratch/alpha/.archiving"
  ( _source_supervisor_with_roles "$scratch"; finish_archiving_roles ) >/dev/null 2>&1
  assert_file "${scratch}-roles/eng/.archiving" "waits: still live, still claimed"
  assert_nofile "${scratch}-roles-archive/eng" "waits: not moved"
  rm -rf "${scratch:?}/alpha"
  ( _source_supervisor_with_roles "$scratch"; finish_archiving_roles ) >/dev/null 2>&1
  assert_file "${scratch}-roles-archive/eng" "moves once its agents have"
  teardown_role_scratch "$scratch"
}

# Test C — a role nobody held moves at once.
test_role_without_agents_moves_at_once() {
  local scratch; scratch=$(setup_role_scratch)
  claim_role "$scratch" lonely
  ( _source_supervisor_with_roles "$scratch"; finish_archiving_roles ) >/dev/null 2>&1
  assert_file "${scratch}-roles-archive/lonely/role.md" "moved"
  teardown_role_scratch "$scratch"
}

# Test D — an archived role of the same name in the way: the claim stays and says why.
test_role_collision_is_written_into_the_claim() {
  local scratch; scratch=$(setup_role_scratch)
  claim_role "$scratch" eng
  mkdir -p "${scratch}-roles-archive/eng"
  local out
  out=$( _source_supervisor_with_roles "$scratch"; finish_archiving_roles 2>&1 ) || true
  assert_file "${scratch}-roles/eng/role.md" "role stays live"
  assert_eq "an archived role named 'eng' is in the way in the archive" \
    "$(jq -r '.last_error' "${scratch}-roles/eng/.archiving")" "the claim says what's in the way"
  assert_eq "r1" "$(jq -r '.id' "${scratch}-roles/eng/.archiving")" "the claim is kept"
  assert_grep "already exists" "$out" "LOUD log"
  teardown_role_scratch "$scratch"
}

# Test E — a role with no claim is left alone.
test_unclaimed_role_is_left_alone() {
  local scratch; scratch=$(setup_role_scratch)
  fixture_role_folder "$scratch" eng
  ( _source_supervisor_with_roles "$scratch"; finish_archiving_roles ) >/dev/null 2>&1
  assert_file "${scratch}-roles/eng/role.md" "untouched"
  teardown_role_scratch "$scratch"
}

# Test F — an agent's failing retire is written into its claim, and retried no sooner than
# ARCHIVE_RETRY_GAP_SECS later.
test_failing_agent_archive_says_why_and_waits_to_retry() {
  _stub_preamble || { PASS=$((PASS + 1)); return; }
  local scratch; scratch=$(setup_role_scratch)
  fixture_identity "$scratch" delta --role eng; printf '{"id":"a1"}' > "$scratch/delta/.archiving"
  fixture_relay_json "$scratch/delta" "http://127.0.0.1:STUB_PORT/_matrix/client/v3" "@delta:test" "pw" "tok"
  start_stub_homeserver 500 || { teardown_role_scratch "$scratch"; return; }
  sed -i "s|STUB_PORT|$STUB_PORT|" "$scratch/delta/relay.json"
  ( _source_supervisor_with_roles "$scratch"; finish_archiving_identities ) >/dev/null 2>&1
  assert_eq "couldn't switch the chat account off" "$(jq -r '.last_error' "$scratch/delta/.archiving")" "reason recorded"
  assert_eq "a1" "$(jq -r '.id' "$scratch/delta/.archiving")" "claim kept"
  local since; since=$(jq -r '.failing_since' "$scratch/delta/.archiving")
  local out
  out=$( _source_supervisor_with_roles "$scratch"; finish_archiving_identities 2>&1 ) || true
  stop_stub_homeserver
  assert_nogrep "finishing the claimed archive" "$out" "not retried straight away"
  assert_eq "$since" "$(jq -r '.failing_since' "$scratch/delta/.archiving")" "failing_since kept from the first failure"
  teardown_role_scratch "$scratch"
}

run_test test_role_and_its_agents_finish_in_one_pass
run_test test_role_waits_for_its_agents
run_test test_role_without_agents_moves_at_once
run_test test_role_collision_is_written_into_the_claim
run_test test_unclaimed_role_is_left_alone
run_test test_failing_agent_archive_says_why_and_waits_to_retry

printf '\n===============================\n'
printf 'PASS: %s  FAIL: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'
  for _f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$_f"
  done
  exit 1
fi
exit 0
