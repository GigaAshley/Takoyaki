#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC2317,SC2030,SC2031
#
# Test driver for the project-scoped-apps additions to agent-supervisor.sh:
#   - bounce_old_notes                     a .move-requested note in any live app folder is
#                                          never carried out: removed and answered
#   - change_lock_take / change_lock_give  the supervisor's turn at the change lock
#   - retire_archived_project_apps()       stops + stashes the apps of an archived project
#
# move-app.sh and app-units.sh are stubs that record each call in $CALLS, so these tests
# check the supervisor's decisions; move-app.sh itself is covered by app-units.test.sh.
#
# Usage: bash substrate/scripts/tests/agent-supervisor-app-move.test.sh   (from repo root)

export AGENT_SUPERVISOR_LIB_ONLY=1
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
  mkdir -p "$s/identities" "$s/identities-archive" "$s/apps" "$s/apps-archive" "$s/projects" "$s/units" "$s/.state"
  for stub in move-stub app-units-stub; do
    cat > "$s/$stub.sh" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "$stub" "\$*" >> "$s/calls"
exit "\${STUB_RC:-0}"
STUB
    chmod +x "$s/$stub.sh"
  done
  : > "$s/calls"
  printf '%s' "$s"
}

source_supervisor() {
  local s="$1"
  export AGENT_IDENTITIES_DIR="$s/identities"
  export AGENT_IDENTITIES_ARCHIVE_DIR="$s/identities-archive"
  export AGENT_ROLES_DIR="$s/roles"
  export AGENT_ROLES_ARCHIVE_DIR="$s/roles-archive"
  export AGENT_APPS_DIR="$s/apps"
  export AGENT_APPS_ARCHIVE_DIR="$s/apps-archive"
  export AGENT_FLEET_PROJECTS_DIR="$s/projects"
  export AGENT_SYSTEMD_UNIT_DIR="$s/units"
  export AGENT_APP_CREATE_LOCK="$s/.create-lock"
  export AGENT_APP_UNITS_SCRIPT="$s/app-units-stub.sh"
  export AGENT_APP_MOVE_SCRIPT="$s/move-stub.sh"
  export AGENT_SYSTEMCTL_BIN=true
  export DORMANCY_STATE_DIR="$s/.state"
  export SUPERVISOR_LOG="$s/supervisor.log"
  # shellcheck disable=SC1090
  source "$SUPERVISOR" 2>/dev/null || true
}

app() { mkdir -p "$1"; printf '{"title": "%s", "description": ""}\n' "${2:-Tally}" > "$1/app.json"; }

test_move_notes_are_never_carried_out() {
  local s; s=$(setup)
  export AGENT_FLEET_CHANGE_BIN="$s/fleet-change-should-not-run"
  app "$s/apps/tally"; printf '{"to":"project","project":"garden"}' > "$s/apps/tally/.move-requested"
  app "$s/projects/garden/apps/beds"; printf '{"to":"sidebar","users":null}' > "$s/projects/garden/apps/beds/.move-requested"
  mkdir -p "$s/identities/alpha"; printf -- '---\nroles: []\n---\n' > "$s/identities/alpha/alpha.md"
  app "$s/identities/alpha/apps/notes"; printf '{"to":"sidebar","users":null}' > "$s/identities/alpha/apps/notes/.move-requested"
  ( source_supervisor "$s"; bounce_old_notes >/dev/null 2>&1 )
  assert_eq "" "$(cat "$s/calls")" "nothing moved"
  local f
  for f in apps/tally projects/garden/apps/beds identities/alpha/apps/notes; do
    assert_absent "$s/$f/.move-requested" "note removed: $f"
    assert_exists "$s/$f/app.json" "app left where it was: $f"
  done
  grep -qF "fleet-change submit app-move '{\"slug\":\"tally\"" "$s/apps/tally/.not-carried-out" || fail "sidebar app reply"
  grep -qF "fleet-change submit app-move '{\"slug\":\"beds\"" "$s/projects/garden/apps/beds/.not-carried-out" || fail "project app reply"
  grep -qF "fleet-change submit app-move '{\"slug\":\"notes\"" "$s/identities/alpha/inbox/"*.msg 2>/dev/null || fail "conversation's agent told"
  assert_absent "$s/identities/alpha/apps/notes/.not-carried-out" "no reply file when the agent is told"
  rm -rf "$s"
}

# The supervisor's turn and the front door's turn exclude each other.
test_supervisor_change_lock_excludes_the_front_door() {
  local s; s=$(setup)
  export AGENT_FLEET_CHANGE_BIN="$REPO_ROOT/substrate/scripts/fleet-change"
  (
    source_supervisor "$s"
    change_lock_take || { echo "take failed" > "$s/lock-result"; exit 0; }
    if flock -n "$s/.change-lock" true; then echo "free while held" > "$s/lock-result"; fi
    change_lock_take; change_lock_give        # re-entrant
    if flock -n "$s/.change-lock" true; then echo "free while still held" >> "$s/lock-result"; fi
    change_lock_give
    flock -n "$s/.change-lock" true || echo "still held after give" >> "$s/lock-result"
  )
  assert_eq "" "$(cat "$s/lock-result" 2>/dev/null)" "lock held exactly while taken"
  rm -rf "$s"
}

test_retire_archived_project_apps() {
  local s; s=$(setup)
  mkdir -p "$s/projects/archive/garden/apps/beds" "$s/projects/live/apps/kept" "$s/apps/side"
  printf '[Service]\nWorkingDirectory=%s\n' "$s/projects/garden/apps/beds" > "$s/units/app-beds.service"
  printf '[Service]\nWorkingDirectory=%s\n' "$s/projects/live/apps/kept" > "$s/units/app-kept.service"
  printf '[Service]\nWorkingDirectory=%s\n' "$s/apps/side" > "$s/units/app-side.service"
  # Units written just before their folder (an app being created) — nothing in the archive.
  printf '[Service]\nWorkingDirectory=%s\n' "$s/projects/live/apps/new" > "$s/units/app-new.service"
  ( source_supervisor "$s"; retire_archived_project_apps >/dev/null 2>&1 )
  assert_eq "app-units-stub stash beds $s/projects/archive/garden/apps/beds
app-units-stub uninstall beds" "$(cat "$s/calls")" "only the archived project's app"
  rm -rf "$s"
}

printf 'agent-supervisor app move tests\n'
run_test test_move_notes_are_never_carried_out
run_test test_supervisor_change_lock_excludes_the_front_door
run_test test_retire_archived_project_apps

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
