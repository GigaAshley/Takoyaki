#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC2317
# (SC2317: test functions are called indirectly via run_test)
#
# Test driver for the supervisor's side of archives going through the front door:
#   - scan_archive_notes: `.archive-requested` / `.unarchive-requested` notes left the
#     old way (an agent's /id archive, a scheduled conversation, a tab from before the
#     front door) are handed to fleet-change as requests, and removed once handed over
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
  export AGENT_FLEET_CHANGE_BIN="$SCRIPT_DIR/fixtures/fake-fleet-change"
  export FAKE_FLEET_CHANGE_LOG="$s/calls"
  export DORMANCY_STATE_DIR="$s/.state"
  export SUPERVISOR_LOG="$s/supervisor.log"
  export AGENT_SUPERVISOR_LIB_ONLY=1
  # shellcheck disable=SC1090
  source "$SUPERVISOR" 2>/dev/null || true
}

agent() { mkdir -p "$1/fleet/identities/$2"; printf -- '---\nroles: []\n---\n' > "$1/fleet/identities/$2/$2.md"; }

test_notes_are_handed_to_the_front_door() {
  local s; s=$(setup)
  agent "$s" finch; : > "$s/fleet/identities/finch/.archive-requested"
  mkdir -p "$s/fleet/roles/eng"; : > "$s/fleet/roles/eng/.archive-requested"
  mkdir -p "$s/fleet/apps/tally"; : > "$s/fleet/apps/tally/.archive-requested"
  mkdir -p "$s/fleet/identities-archive/wren"; : > "$s/fleet/identities-archive/wren/.unarchive-requested"
  mkdir -p "$s/fleet/roles-archive/ops"; : > "$s/fleet/roles-archive/ops/.unarchive-requested"
  mkdir -p "$s/fleet/apps-archive/beds"; : > "$s/fleet/apps-archive/beds/.unarchive-requested"
  ( source_supervisor "$s"; scan_archive_notes ) >/dev/null 2>&1
  local calls; calls="$(cat "$s/calls" 2>/dev/null)"
  local want
  for want in 'submit agent-archive {"name":"finch","by":"agent"}' 'submit role-archive {"name":"eng"}' \
              'submit app-archive {"slug":"tally"}' 'submit agent-unarchive {"name":"wren"}' \
              'submit role-unarchive {"name":"ops"}' 'submit app-unarchive {"slug":"beds"}'; do
    printf '%s\n' "$calls" | grep -qF -- "$want --id note-" || fail "not handed over: $want (calls: $calls)"
  done
  assert_absent "$s/fleet/identities/finch/.archive-requested" "agent note removed"
  assert_absent "$s/fleet/apps-archive/beds/.unarchive-requested" "app note removed"
  rm -rf "$s"
}

test_note_is_kept_when_the_front_door_fails() {
  local s; s=$(setup)
  agent "$s" finch; : > "$s/fleet/identities/finch/.archive-requested"
  ( source_supervisor "$s"; FAKE_FLEET_CHANGE_RC=1 scan_archive_notes ) >/dev/null 2>&1
  assert_exists "$s/fleet/identities/finch/.archive-requested" "kept for the next pass"
  rm -rf "$s"
}

test_same_note_gets_the_same_request_id() {
  local s; s=$(setup)
  agent "$s" finch; : > "$s/fleet/identities/finch/.archive-requested"
  touch -d '2026-01-01 00:00' "$s/fleet/identities/finch/.archive-requested"
  ( source_supervisor "$s"; FAKE_FLEET_CHANGE_RC=1 scan_archive_notes; FAKE_FLEET_CHANGE_RC=1 scan_archive_notes ) >/dev/null 2>&1
  assert_eq 1 "$(grep -o 'note-[0-9a-f]*' "$s/calls" | sort -u | wc -l | tr -d ' ')" "one id for one note"
  rm -rf "$s"
}

test_sleep_sweep_asks_the_front_door() {
  local s; s=$(setup)
  agent "$s" finch; touch -d '2025-01-01' "$s/fleet/identities/finch"
  ( source_supervisor "$s"; run_archive_scan ) >/dev/null 2>&1
  grep -qF 'submit agent-archive {"name":"finch","dormant":true} --id dormant-finch-' "$s/calls" \
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

printf 'agent-supervisor archive notes tests\n'
run_test test_notes_are_handed_to_the_front_door
run_test test_note_is_kept_when_the_front_door_fails
run_test test_same_note_gets_the_same_request_id
run_test test_sleep_sweep_asks_the_front_door
run_test test_claimed_agent_is_never_launched
run_test test_wake_file_ends_the_wait_early
run_test test_claimed_agents_are_all_stopped_at_once

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
