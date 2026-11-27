#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC2317
# (SC2317: test functions are called indirectly via run_test)
#
# Test driver for the supervisor's side of archives going through the front door:
#   - bounce_old_notes: `.archive-requested` / `.unarchive-requested` notes left the old way
#     are never carried out: removed, and answered (the agent told, or a reply beside it);
#     a request file left in ~/fleet/spawn-requests/ is answered with a failure file
#   - run_archive_scan: the 180-day sleep sweep asks the front door instead of retiring
#   - resolve_identities: an agent whose archive is claimed is never launched
#   - wait_for_next_tick: the front door's wake file ends the wait early
#   - finish_archiving_identities: every claimed agent is stopped in the same pass, even when
#     the rest of its archive can't be finished yet
#
# fleet-change is the stand-in fixtures/fake-fleet-change, which records each call.
#
# Usage: bash substrate/scripts/tests/agent-supervisor-archive-notes.test.sh   (from repo root)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SUPERVISOR="${SUPERVISOR:-$REPO_ROOT/substrate/scripts/agent-supervisor.sh}"
[ -f "$SUPERVISOR" ] || { printf 'FATAL: supervisor not found at %s\n' "$SUPERVISOR" >&2; exit 1; }

PASS=0
FAIL=0
FAILURES=()
CURRENT_TEST=""

fail() { FAILURES+=("${CURRENT_TEST:-unknown}: ${1:-unknown failure}"); FAIL=$((FAIL + 1)); }
assert_eq() { [ "$1" = "$2" ] || fail "${3:-assert_eq}: expected='$1' got='$2'"; }
assert_exists() { [ -e "$1" ] || fail "${2:-assert_exists}: missing $1"; }
assert_absent() { [ ! -e "$1" ] || fail "${2:-assert_absent}: unexpectedly present $1"; }

run_test() {
  local fn="$1" before=$FAIL
  CURRENT_TEST="$fn"
  "$fn"
  if [ "$FAIL" -eq "$before" ]; then PASS=$((PASS + 1)); printf '  OK   %s\n' "$fn"; else printf '  FAIL %s\n' "$fn"; fi
  CURRENT_TEST=""
}

setup() {
  local s; s=$(mktemp -d)
  mkdir -p "$s/fleet/identities" "$s/fleet/identities-archive" "$s/fleet/roles" "$s/fleet/roles-archive" \
           "$s/fleet/apps" "$s/fleet/apps-archive" "$s/.state"
  printf '%s' "$s"
}

source_supervisor() {
  local s="$1"
  export AGENT_IDENTITIES_DIR="$s/fleet/identities"
  export AGENT_IDENTITIES_ARCHIVE_DIR="$s/fleet/identities-archive"
  export AGENT_ROLES_DIR="$s/fleet/roles"
  export AGENT_ROLES_ARCHIVE_DIR="$s/fleet/roles-archive"
  export AGENT_APPS_DIR="$s/fleet/apps"
  export AGENT_APPS_ARCHIVE_DIR="$s/fleet/apps-archive"
  export AGENT_FLEET_PROJECTS_DIR="$s/fleet/projects"
  export AGENT_FLEET_CHANGE_BIN="$SCRIPT_DIR/fixtures/fake-fleet-change"
  export FAKE_FLEET_CHANGE_LOG="$s/calls"
  export DORMANCY_STATE_DIR="$s/.state"
  export SUPERVISOR_LOG="$s/supervisor.log"
  export AGENT_SUPERVISOR_LIB_ONLY=1
  # shellcheck disable=SC1090
  source "$SUPERVISOR" 2>/dev/null || true
}

agent() { mkdir -p "$1/fleet/identities/$2"; printf -- '---\nroles: []\n---\n' > "$1/fleet/identities/$2/$2.md"; }

test_old_notes_are_never_carried_out() {
  local s; s=$(setup)
  agent "$s" finch; : > "$s/fleet/identities/finch/.archive-requested"
  mkdir -p "$s/fleet/roles/eng"; : > "$s/fleet/roles/eng/.archive-requested"
  mkdir -p "$s/fleet/apps/tally"; : > "$s/fleet/apps/tally/.archive-requested"
  mkdir -p "$s/fleet/identities-archive/wren"; : > "$s/fleet/identities-archive/wren/.unarchive-requested"
  mkdir -p "$s/fleet/roles-archive/ops"; : > "$s/fleet/roles-archive/ops/.unarchive-requested"
  mkdir -p "$s/fleet/apps-archive/beds"; : > "$s/fleet/apps-archive/beds/.unarchive-requested"
  ( source_supervisor "$s"; bounce_old_notes ) >/dev/null 2>&1
  assert_absent "$s/calls" "nothing handed to the front door"
  local f
  for f in identities/finch/.archive-requested roles/eng/.archive-requested apps/tally/.archive-requested \
           identities-archive/wren/.unarchive-requested roles-archive/ops/.unarchive-requested \
           apps-archive/beds/.unarchive-requested; do
    assert_absent "$s/fleet/$f" "note removed: $f"
  done
  # The agent's own note: answered in its conversation.
  grep -qF "fleet-change submit agent-archive '{\"name\":\"finch\",\"by\":\"agent\"}' --by agent:finch" \
    "$s/fleet/identities/finch/inbox/"*.msg 2>/dev/null || fail "finch wasn't told what to run"
  assert_absent "$s/fleet/identities/finch/.not-carried-out" "no reply file for an agent told directly"
  # Any other: a reply beside it.
  grep -qF "fleet-change submit role-archive '{\"name\":\"eng\"}'" "$s/fleet/roles/eng/.not-carried-out" || fail "role reply"
  grep -qF "fleet-change submit app-archive '{\"slug\":\"tally\"}'" "$s/fleet/apps/tally/.not-carried-out" || fail "app reply"
  grep -qF "fleet-change submit agent-unarchive '{\"name\":\"wren\"}'" "$s/fleet/identities-archive/wren/.not-carried-out" || fail "agent un-archive reply"
  grep -qF "fleet-change submit role-unarchive '{\"name\":\"ops\"}'" "$s/fleet/roles-archive/ops/.not-carried-out" || fail "role un-archive reply"
  grep -qF "fleet-change submit app-unarchive '{\"slug\":\"beds\"}'" "$s/fleet/apps-archive/beds/.not-carried-out" || fail "app un-archive reply"
  rm -rf "$s"
}

test_old_new_agent_requests_are_answered() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/spawn-requests"
  printf '{"roles":[],"task":"t","prompt":"p","requested_at":"x"}' > "$s/fleet/spawn-requests/aaa.json"
  printf '{"kind":"role","name":"Gardener","description":"d","requested_at":"x"}' > "$s/fleet/spawn-requests/bbb.json"
  printf '{"name":"x"}' > "$s/fleet/spawn-requests/ccc.success.json"
  printf '{}' > "$s/fleet/spawn-requests/ddd.claimed.json"
  ( source_supervisor "$s"; bounce_old_notes ) >/dev/null 2>&1
  assert_absent "$s/fleet/spawn-requests/aaa.json" "request removed"
  assert_absent "$s/fleet/spawn-requests/bbb.json" "role request removed"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["reason"]=="retired" and "identity-birth" in d["message"], d' \
    "$s/fleet/spawn-requests/aaa.failure.json" 2>/dev/null || fail "new-agent request not answered: $(cat "$s/fleet/spawn-requests/aaa.failure.json" 2>/dev/null)"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["reason"]=="retired" and "role-create" in d["message"], d' \
    "$s/fleet/spawn-requests/bbb.failure.json" 2>/dev/null || fail "role request not answered"
  assert_exists "$s/fleet/spawn-requests/ccc.success.json" "answers left alone"
  assert_exists "$s/fleet/spawn-requests/ddd.claimed.json" "claimed files left alone"
  assert_absent "$s/fleet/spawn-requests/ccc.success.failure.json" "an answer isn't answered"
  rm -rf "$s"
}

test_sleep_sweep_asks_the_front_door() {
  local s; s=$(setup)
  agent "$s" finch; touch -d '2025-01-01' "$s/fleet/identities/finch"
  ( source_supervisor "$s"; run_archive_scan ) >/dev/null 2>&1
  grep -qF 'submit agent-archive {"name":"finch","dormant":true,"idleFor":15552000} --id dormant-finch-' "$s/calls" \
    || fail "sweep didn't ask the front door: $(cat "$s/calls" 2>/dev/null)"
  assert_exists "$s/fleet/identities/finch/finch.md" "nothing retired directly"
  rm -rf "$s"
}

test_claimed_agent_is_never_launched() {
  local s; s=$(setup)
  agent "$s" finch; agent "$s" wren; : > "$s/fleet/identities/wren/.archiving"
  local got; got="$( source_supervisor "$s"; resolve_identities; printf '%s ' "${IDENTITIES[@]}" )"
  assert_eq "finch " "$got" "claimed agent left out"
  rm -rf "$s"
}

test_wake_file_ends_the_wait_early() {
  command -v inotifywait >/dev/null 2>&1 || { printf '  (inotifywait missing — skipped)\n'; return; }
  local s; s=$(setup)
  local t0 t1
  t0=$(date +%s)
  ( source_supervisor "$s"; CHECK_INTERVAL=20 NEW_IDENTITY_MIN_GAP=0
    IDENTITY_LISTING_AT_TICK="$(identity_listing)"
    ( sleep 1; printf 'x' > "$s/fleet/identities/.supervisor-wake.tmp"; mv "$s/fleet/identities/.supervisor-wake.tmp" "$s/fleet/identities/.supervisor-wake" ) &
    wait_for_next_tick ) >/dev/null 2>&1
  t1=$(date +%s)
  [ $((t1 - t0)) -lt 10 ] || fail "waited $((t1 - t0))s; the wake file should end it within a few"
  rm -rf "$s"
}

test_claimed_agents_are_all_stopped_at_once() {
  command -v tmux >/dev/null 2>&1 || { printf '  (tmux missing — skipped)\n'; return; }
  local s; s=$(setup)
  local a="zclaim-a-$$" b="zclaim-b-$$"
  agent "$s" "$a"; agent "$s" "$b"
  : > "$s/fleet/identities/$a/.archiving"; : > "$s/fleet/identities/$b/.archiving"
  tmux new-session -d -s "$a" "sleep 300"; tmux new-session -d -s "$b" "sleep 300"
  # (Sourced inside a function, the supervisor's session table would be that function's own.)
  ( source_supervisor "$s"; declare -gA SESSIONS_SNAPSHOT=(); snapshot_sessions; finish_archiving_identities ) >/dev/null 2>&1
  tmux has-session -t "=$a" 2>/dev/null && fail "$a still running"
  tmux has-session -t "=$b" 2>/dev/null && fail "$b still running"
  assert_exists "$s/fleet/identities/$a/.archiving" "claim kept while its archive can't finish (no chat login here)"
  tmux kill-session -t "=$a" 2>/dev/null; tmux kill-session -t "=$b" 2>/dev/null
  rm -rf "$s"
}

test_wake_during_the_pass_is_not_lost() {
  local s; s=$(setup)
  local t0 t1
  printf 'x' > "$s/fleet/identities/.supervisor-wake"
  t0=$(date +%s)
  ( source_supervisor "$s"; CHECK_INTERVAL=20 NEW_IDENTITY_MIN_GAP=0 PASS_STARTED_AT=$((t0 - 1))
    IDENTITY_LISTING_AT_TICK="$(identity_listing)"; wait_for_next_tick ) >/dev/null 2>&1
  t1=$(date +%s)
  [ $((t1 - t0)) -lt 5 ] || fail "waited $((t1 - t0))s for a wake that came during the pass"
  rm -rf "$s"
}

printf 'agent-supervisor archive notes tests\n'
run_test test_old_notes_are_never_carried_out
run_test test_old_new_agent_requests_are_answered
run_test test_sleep_sweep_asks_the_front_door
run_test test_claimed_agent_is_never_launched
run_test test_wake_file_ends_the_wait_early
run_test test_wake_during_the_pass_is_not_lost
run_test test_claimed_agents_are_all_stopped_at_once

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
