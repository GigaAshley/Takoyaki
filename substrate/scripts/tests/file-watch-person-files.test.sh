#!/usr/bin/env bash
# shellcheck shell=bash
# Test driver for file-watch.py person-file and instance-wide-file coverage.
#
# Person files (~/fleet/people/<user>.md) of the people the agent is shared
# with are watched; who it's shared with is re-worked out when the identity
# file, a role file or the machine's people list changes, and compared with
# what the agent was last told (kept on disk). Only people with a file are
# ever mentioned. The instance-wide CLAUDE.md is watched like the user-wide
# one, and may come and go without killing the watcher.
#
# Covers:
#   T-F1  — cold start with files: silent; set recorded.
#   T-F2  — edit / add / delete of a shared person's file.
#   T-F3  — files of people the agent isn't shared with stay silent.
#   T-F4  — identity `users:` edit: now also shared / no longer shared.
#   T-F5  — role `users:` edit narrows the set.
#   T-F6  — machine people list replaced (atomic rename): person removed.
#   T-F7  — nobody has a file: sharing changes say nothing.
#   T-F8  — changes made while the watcher was down are told at restart.
#   T-F9  — agent's own edit to a person file (claimed via the self-edit
#           hook) stays silent.
#   T-Z1  — a shared person's new time zone is told (no About you files
#           needed); first run, unchanged lists, people not shared with and
#           a zone going unknown stay silent.
#   T-Z2  — a time zone change made while the watcher was down is told.
#   T-I1  — instance-wide file edit fires; removal is told once and the
#           watcher survives; it coming back is told.
#   T-I2  — instance-wide file absent at start, then appears: told.
#
# Exits 0 on all-pass; 1 on any failure.
#
# Usage: bash substrate/scripts/tests/file-watch-person-files.test.sh
#   Run from the repo root.
#
# Requirements: bash, python3, inotifywait, jq.

set -u

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PY_SCRIPT="$REPO_ROOT/substrate/scripts/file-watch.py"
SYNC_SCRIPT="$REPO_ROOT/substrate/scripts/self-edit-baseline-sync.sh"

for bin in python3 inotifywait jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf 'FATAL: %s not found\n' "$bin" >&2
    exit 1
  fi
done

PASS=0
FAIL=0
FAILURES=()
declare -a ALL_TMPDIRS=()
declare -a ALL_PIDS=()

cleanup() {
  for _p in "${ALL_PIDS[@]+"${ALL_PIDS[@]}"}"; do
    [ -n "$_p" ] && kill "$_p" 2>/dev/null
  done
  for _d in "${ALL_TMPDIRS[@]+"${ALL_TMPDIRS[@]}"}"; do
    [ -n "$_d" ] && [ -d "$_d" ] && rm -rf "$_d"
  done
}
trap cleanup EXIT

make_tmpdir() {
  local d
  d=$(mktemp -d)
  ALL_TMPDIRS+=("$d")
  printf '%s' "$d"
}

fail() {
  FAILURES+=("${CURRENT_TEST:-unknown}: ${1:-unknown failure}")
  FAIL=$((FAIL + 1))
}

run_test() {
  local test_fn="$1"
  local before_fail=$FAIL
  CURRENT_TEST="$test_fn"
  "$test_fn"
  stop_watcher
  if [ "$FAIL" -eq "$before_fail" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$test_fn"
  else
    printf 'FAIL  %s\n' "$test_fn"
  fi
}

NAME="pfagent"

# seed_fixture <identity users line or ""> <people on the machine...>
seed_fixture() {
  local users_line="$1"
  shift
  HOME_DIR=$(make_tmpdir)
  IDENT_DIR="$HOME_DIR/fleet/identities/$NAME"
  IDENT_MD="$IDENT_DIR/$NAME.md"
  STATE="$IDENT_DIR/file-watch"
  ROLE_MD="$HOME_DIR/fleet/roles/rolex/rolex.md"
  PEOPLE="$HOME_DIR/fleet/people"
  INSTANCE="$HOME_DIR/etc-claude-code/CLAUDE.md"
  mkdir -p "$IDENT_DIR" "$(dirname "$ROLE_MD")" "$PEOPLE" "$HOME_DIR/fleet/host" "$(dirname "$INSTANCE")"
  write_role ""
  write_identity "$users_line"
  write_people "$@"
}

write_identity() {
  local fm="roles: rolex
task: t"
  [ -n "$1" ] && fm="$fm
$1"
  printf -- '---\n%s\n---\n\n# %s\n' "$fm" "$NAME" > "$IDENT_MD.tmp"
  mv "$IDENT_MD.tmp" "$IDENT_MD"
}

write_role() {
  local fm="displayName: Rolex"
  [ -n "$1" ] && fm="$fm
$1"
  printf -- '---\n%s\n---\n\n# rolex\n' "$fm" > "$ROLE_MD.tmp"
  mv "$ROLE_MD.tmp" "$ROLE_MD"
}

# The app writes the people list to a .new file and renames it into place.
write_people() {
  local f="$HOME_DIR/fleet/host/people.md"
  { printf 'People on this machine — x\n\n'
    for p in "$@"; do printf -- '- %s · no relay ID\n' "$p"; done
  } > "$f.new"
  mv "$f.new" "$f"
}

# Same, with each person's time zone: write_people_tz amy=America/Denver zed=
# (blank = not set).
write_people_tz() {
  local f="$HOME_DIR/fleet/host/people.md"
  { printf 'People on this machine — x\n\n'
    for p in "$@"; do
      local who="${p%%=*}" zone="${p#*=}"
      printf -- '- %s · relay ID @%s:x · time zone %s\n' "$who" "$who" "${zone:-not set}"
    done
  } > "$f.new"
  mv "$f.new" "$f"
}

launch_watcher() {
  OUT_LOG=$(make_tmpdir)/out.log
  ERR_LOG=$(make_tmpdir)/err.log
  HOME="$HOME_DIR" AMBIENT_MONITOR_HARNESS_PID="$$" \
    FILE_WATCH_INSTANCE_CLAUDEMD="$INSTANCE" FILE_WATCH_CHAIN_POLL_SEC=0.5 \
    python3 "$PY_SCRIPT" "$IDENT_DIR" >/dev/null 2>"$ERR_LOG" &
  WATCHER_PID=$!
  ALL_PIDS+=("$WATCHER_PID")
  [ -n "${COLLECTOR_PID:-}" ] && kill "$COLLECTOR_PID" 2>/dev/null
  ( q="$IDENT_DIR/pending-context"
    while :; do
      for f in $(ls "$q" 2>/dev/null | grep '\.line$' | sort); do
        cat "$q/$f"; echo; rm -f "$q/$f"
      done
      sleep 0.05
    done ) >>"$OUT_LOG" 2>/dev/null &
  COLLECTOR_PID=$!
  ALL_PIDS+=("$COLLECTOR_PID")
}

stop_watcher() {
  [ -n "${WATCHER_PID:-}" ] && kill "$WATCHER_PID" 2>/dev/null
  # Re-execs keep the PID; wait for it to really be gone before a relaunch.
  [ -n "${WATCHER_PID:-}" ] && wait_for 50 bash -c "! kill -0 $WATCHER_PID 2>/dev/null"
  WATCHER_PID=""
  sleep 0.2  # let the collector drain
}

wait_for() {
  local timeout="$1" elapsed=0
  shift
  while [ "$elapsed" -lt "$timeout" ]; do
    "$@" && return 0
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
  return 1
}

out_has() { [ -f "$OUT_LOG" ] && grep -qE "$1" "$OUT_LOG"; }
alive() { kill -0 "$WATCHER_PID" 2>/dev/null; }
logs() { printf 'out=%s err=%s' "$(cat "$OUT_LOG" 2>/dev/null)" "$(tail -5 "$ERR_LOG" 2>/dev/null)"; }
wait_armed() { wait_for 50 test -f "$STATE/last-snapshot.identity"; sleep 1; }

test_T_F1_cold_start_silent() {
  seed_fixture "" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  [ -s "$OUT_LOG" ] && { fail "cold start not silent; $(logs)"; return; }
  [ "$(cat "$STATE/last-people")" = '["amy", "zed"]' ] || fail "last-people wrong: $(cat "$STATE/last-people")"
}

test_T_F2_edit_add_delete() {
  seed_fixture "" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  printf 'Amy likes green tea.\n' > "$PEOPLE/amy.md"
  wait_for 50 out_has "📝 \[person-file: amy\] amy's About you changed — .*green tea" \
    || { fail "no change notice; $(logs)"; return; }
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md.tmp"; mv "$PEOPLE/zed.md.tmp" "$PEOPLE/zed.md"
  wait_for 50 out_has "📝 \[person-file: zed\] zed's About you was added: Zed likes coffee\." \
    || { fail "no added notice; $(logs)"; return; }
  rm "$PEOPLE/amy.md"
  wait_for 50 out_has "📝 \[person-file: amy\] amy's About you was deleted — stop going by it" \
    || { fail "no deleted notice; $(logs)"; return; }
  [ -f "$STATE/last-snapshot.person.amy" ] && fail "amy baseline kept after delete"
}

test_T_F3_unshared_person_silent() {
  seed_fixture "users: [amy]" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  [ -f "$STATE/last-snapshot.person.zed" ] && { fail "baseline for a person not shared with"; return; }
  printf 'Zed changed.\n' > "$PEOPLE/zed.md"
  printf 'Amy changed.\n' > "$PEOPLE/amy.md"
  wait_for 50 out_has "\[person-file: amy\]" || { fail "amy edit not told; $(logs)"; return; }
  sleep 0.5
  out_has "zed" && fail "unshared person's edit told; $(logs)"
}

test_T_F4_identity_list_change() {
  seed_fixture "users: [amy]" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  write_identity "users: [amy, zed]"
  wait_for 50 out_has "📝 \[person-file: zed\] you're now also shared with zed — their About you: Zed likes coffee\." \
    || { fail "no now-shared notice; $(logs)"; return; }
  printf 'Zed likes espresso.\n' > "$PEOPLE/zed.md"
  wait_for 50 out_has "zed's About you changed — .*espresso" || { fail "newly shared file not watched; $(logs)"; return; }
  write_identity "users: [amy]"
  wait_for 50 out_has "📝 \[person-file: zed\] you're no longer shared with zed — stop going by their About you" \
    || { fail "no no-longer notice; $(logs)"; return; }
  [ -f "$STATE/last-snapshot.person.zed" ] && fail "zed baseline kept after unsharing"
  out_has "person-file: amy" && fail "amy mentioned though unchanged; $(logs)"
}

test_T_F5_role_list_change() {
  seed_fixture "" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.zed" || { fail "zed baseline never landed; $(logs)"; return; }
  wait_armed
  write_role "$(printf 'users:\n  - amy\n')"
  wait_for 50 out_has "you're no longer shared with zed" || { fail "role list change not told; $(logs)"; return; }
}

test_T_F6_people_list_replaced() {
  seed_fixture "" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.zed" || { fail "zed baseline never landed; $(logs)"; return; }
  wait_armed
  write_people amy
  wait_for 50 out_has "you're no longer shared with zed" || { fail "people list change not told; $(logs)"; return; }
  write_people amy zed
  wait_for 50 out_has "you're now also shared with zed" || { fail "re-added person not told; $(logs)"; return; }
  alive || fail "watcher died; $(logs)"
}

test_T_F7_no_files_silent() {
  seed_fixture "" amy
  launch_watcher
  wait_armed
  write_people amy zed
  write_identity "users: [zed]"
  sleep 1.5
  # The identity-file edit itself is still told, as always.
  out_has "person-file" && { fail "told something with no person files; $(logs)"; return; }
  [ "$(cat "$STATE/last-people" 2>/dev/null)" = '["zed"]' ] || fail "set not recorded: $(cat "$STATE/last-people" 2>/dev/null)"
}

test_T_F8_changes_while_down() {
  seed_fixture "users: [amy]" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  stop_watcher
  printf 'Amy likes oolong.\n' > "$PEOPLE/amy.md"
  write_identity "users: [amy, zed]"
  launch_watcher
  wait_for 50 out_has "amy's About you changed — .*oolong" || { fail "edit while down not told; $(logs)"; return; }
  wait_for 50 out_has "you're now also shared with zed" || { fail "sharing change while down not told; $(logs)"; return; }
}

test_T_F9_self_edit_silent() {
  seed_fixture "" amy
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  local payload
  payload=$(jq -nc --arg p "$PEOPLE/amy.md" '{hook_event_name:"PreToolUse",tool_name:"Write",tool_use_id:"toolu_f9",tool_input:{file_path:$p}}')
  printf '%s' "$payload" | HOME="$HOME_DIR" FLEET_IDENTITY="$NAME" bash "$SYNC_SCRIPT"
  compgen -G "$STATE/claims/last-snapshot.person.amy.toolu_f9" >/dev/null || { fail "hook did not claim amy.md"; return; }
  printf 'Amy likes tea. (agent edit)\n' > "$PEOPLE/amy.md"
  sleep 0.5
  printf '%s' "${payload/PreToolUse/PostToolUse}" | HOME="$HOME_DIR" FLEET_IDENTITY="$NAME" bash "$SYNC_SCRIPT"
  sleep 1.5
  out_has "agent edit" && { fail "self-edit told; $(logs)"; return; }
  printf 'Amy likes rooibos.\n' > "$PEOPLE/amy.md"
  wait_for 50 out_has "amy's About you changed — .*rooibos" || fail "edit after self-edit not told; $(logs)"
}

test_T_Z1_time_zone_change_told() {
  seed_fixture "users: [amy]" amy zed
  write_people_tz amy=America/New_York zed=Europe/Paris
  launch_watcher
  wait_for 50 test -f "$STATE/last-time-zones" || { fail "zones never recorded; $(logs)"; return; }
  wait_armed
  out_has "time-zone" && { fail "first run told a zone; $(logs)"; return; }
  # Same zones rewritten, and a zone change for someone not shared with: silent.
  write_people_tz amy=America/New_York zed=Asia/Tokyo
  sleep 1.5
  out_has "time-zone" && { fail "told a zone that didn't change for a shared person; $(logs)"; return; }
  write_people_tz amy=America/Denver zed=Asia/Tokyo
  wait_for 50 out_has "📝 \[time-zone: amy\] amy's time zone is now America/Denver" \
    || { fail "zone change not told; $(logs)"; return; }
  [ "$(grep -c "time-zone" "$OUT_LOG")" = 1 ] || { fail "told more than once; $(logs)"; return; }
  # Going unknown is recorded, not told; coming back is told.
  write_people_tz amy= zed=Asia/Tokyo
  sleep 1.5
  [ "$(grep -c "time-zone" "$OUT_LOG")" = 1 ] || { fail "told a zone going unknown; $(logs)"; return; }
  write_people_tz amy=America/Denver zed=Asia/Tokyo
  zone_notes_are() { [ "$(grep -c "time-zone" "$OUT_LOG")" = "$1" ]; }
  wait_for 50 zone_notes_are 2 || { fail "zone coming back not told; $(logs)"; return; }
  out_has "person-file" && fail "person-file notice with no person files; $(logs)"
  alive || fail "watcher died; $(logs)"
}

test_T_Z2_time_zone_change_while_down() {
  seed_fixture "" amy
  write_people_tz amy=America/New_York
  launch_watcher
  wait_for 50 test -f "$STATE/last-time-zones" || { fail "zones never recorded; $(logs)"; return; }
  wait_armed
  stop_watcher
  write_people_tz amy=America/Chicago
  launch_watcher
  wait_for 50 out_has "amy's time zone is now America/Chicago" || fail "change while down not told; $(logs)"
}

test_T_I1_instance_edit_remove_return() {
  seed_fixture "" amy
  printf 'Instance rules.\n' > "$INSTANCE"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.instance-claudemd" || { fail "instance baseline never landed; $(logs)"; return; }
  wait_armed
  printf 'Instance rules, revised.\n' > "$INSTANCE"
  wait_for 50 out_has "📝 \[instance-claudemd: instance\] your instance-wide CLAUDE.md changed — .*revised" \
    || { fail "no instance change notice; $(logs)"; return; }
  rm "$INSTANCE"
  wait_for 50 out_has "your instance-wide CLAUDE.md was removed — stop going by it" \
    || { fail "no removal notice; $(logs)"; return; }
  sleep 1
  alive || { fail "watcher died after removal; $(logs)"; return; }
  [ "$(grep -c 'was removed' "$OUT_LOG")" -eq 1 ] || fail "removal told more than once; $(logs)"
  printf 'Instance rules are back.\n' > "$INSTANCE"
  wait_for 50 out_has "your instance-wide CLAUDE.md was added — Read $INSTANCE" \
    || { fail "no added notice; $(logs)"; return; }
  sleep 1
  printf 'Instance rules are back, edited.\n' > "$INSTANCE"
  wait_for 50 out_has "instance-wide CLAUDE.md changed — .*edited" || fail "edit after return not told; $(logs)"
}

test_T_I2_instance_appears() {
  seed_fixture "" amy
  launch_watcher
  wait_armed
  printf 'New instance rules.\n' > "$INSTANCE"
  wait_for 50 out_has "your instance-wide CLAUDE.md was added — Read $INSTANCE" \
    || { fail "appearance not told; $(logs)"; return; }
  alive || fail "watcher died; $(logs)"
}

test_T_F10_half_written_identity() {
  seed_fixture "users: [amy]" amy zed
  printf 'Amy likes tea.\n' > "$PEOPLE/amy.md"
  printf 'Zed likes coffee.\n' > "$PEOPLE/zed.md"
  launch_watcher
  wait_for 50 test -f "$STATE/last-snapshot.person.amy" || { fail "amy baseline never landed; $(logs)"; return; }
  wait_armed
  # An in-place rewrite caught half-way: frontmatter opened, never closed.
  printf -- '---\nroles: rolex\nus' > "$IDENT_MD"
  printf 'Amy likes oolong.\n' > "$PEOPLE/amy.md"
  sleep 1
  out_has "person-file: zed" && { fail "half-written file widened the set; $(logs)"; return; }
  # Nothing is decided while it's unreadable; once whole again, the held
  # edit is told and the set is unchanged.
  write_identity "users: [amy]"
  wait_for 50 out_has "amy's About you changed — .*oolong" || { fail "held amy edit not told; $(logs)"; return; }
  sleep 0.5
  out_has "person-file: zed" && { fail "zed mentioned; $(logs)"; return; }
  [ "$(cat "$STATE/last-people")" = '["amy"]' ] || fail "set changed: $(cat "$STATE/last-people")"
}

test_T_I3_instance_added_while_down() {
  seed_fixture "" amy
  launch_watcher
  wait_armed
  wait_for 50 test -f "$STATE/instance-armed" || { fail "instance-armed never written; $(logs)"; return; }
  stop_watcher
  printf 'Instance rules.\n' > "$INSTANCE"
  launch_watcher
  wait_for 50 out_has "your instance-wide CLAUDE.md was added — Read $INSTANCE" \
    || fail "instance file added while down not told; $(logs)"
}

test_T_I4_instance_first_run_silent() {
  seed_fixture "" amy
  printf 'Instance rules.\n' > "$INSTANCE"
  # An identity watched before this version: baselines exist, no instance-armed.
  mkdir -p "$STATE"; printf 'old\n' > "$STATE/last-snapshot.identity"
  launch_watcher
  wait_for 50 test -f "$STATE/instance-armed" || { fail "instance-armed never written; $(logs)"; return; }
  sleep 1
  out_has "instance-claudemd" && fail "first run of the new watcher announced the instance file; $(logs)"
}

run_test test_T_F1_cold_start_silent
run_test test_T_F2_edit_add_delete
run_test test_T_F3_unshared_person_silent
run_test test_T_F4_identity_list_change
run_test test_T_F5_role_list_change
run_test test_T_F6_people_list_replaced
run_test test_T_F7_no_files_silent
run_test test_T_F8_changes_while_down
run_test test_T_F9_self_edit_silent
run_test test_T_I1_instance_edit_remove_return
run_test test_T_I2_instance_appears
run_test test_T_F10_half_written_identity
run_test test_T_I3_instance_added_while_down
run_test test_T_I4_instance_first_run_silent
run_test test_T_Z1_time_zone_change_told
run_test test_T_Z2_time_zone_change_while_down

printf '\n===============================\n'
printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
