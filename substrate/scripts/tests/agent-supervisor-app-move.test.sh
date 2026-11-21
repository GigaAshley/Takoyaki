#!/usr/bin/env bash
# shellcheck shell=bash
# shellcheck disable=SC2317,SC2030,SC2031
#
# Test driver for the project-scoped-apps additions to agent-supervisor.sh:
#   - scan_app_move_requested_sentinels()  runs move-app.sh for a .move-requested in any
#                                          live app folder; tells a conversation app's agent
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

test_move_sidebar_app_into_project() {
  local s; s=$(setup)
  app "$s/apps/tally"
  printf '{"to":"project","project":"garden"}' > "$s/apps/tally/.move-requested"
  ( source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_eq "move-stub tally project garden" "$(cat "$s/calls")" "calls"
  assert_absent "$s/apps/tally/.move-requested" "request consumed"
  rm -rf "$s"
}

test_move_project_app_to_sidebar_with_users() {
  local s; s=$(setup)
  app "$s/projects/garden/apps/beds"
  printf '{"to":"sidebar","users":["ann","bob"]}' > "$s/projects/garden/apps/beds/.move-requested"
  ( source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_eq "move-stub beds sidebar --users ann,bob" "$(cat "$s/calls")" "calls"
  rm -rf "$s"
}

test_move_conversation_app_tells_its_agent() {
  local s; s=$(setup)
  app "$s/identities/alpha/apps/tally" 'My <Tally>'
  printf '{"to":"sidebar","users":null}' > "$s/identities/alpha/apps/tally/.move-requested"
  ( source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_eq "move-stub tally sidebar --everyone" "$(cat "$s/calls")" "no list → everyone"
  local msg; msg=$(cat "$s"/identities/alpha/inbox/*.msg 2>/dev/null)
  printf '%s' "$msg" | grep -q 'App moved — delivered by the app' || fail "inbox event: $msg"
  printf '%s' "$msg" | grep -q '"My  Tally " was moved to the sidebar' || fail "title flattened, destination named: $msg"
  rm -rf "$s"
}

test_failed_move_records_reason_and_does_not_tell_agent() {
  local s; s=$(setup)
  app "$s/identities/alpha/apps/tally"
  printf '{"to":"project","project":"garden"}' > "$s/identities/alpha/apps/tally/.move-requested"
  ( export STUB_RC=1; source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_exists "$s/identities/alpha/apps/tally/.move-failed" "reason kept"
  assert_absent "$s/identities/alpha/apps/tally/.move-requested" "not retried every tick"
  assert_absent "$s/identities/alpha/inbox" "agent not told"
  rm -rf "$s"
}

test_bad_requests_are_dropped() {
  local s; s=$(setup)
  app "$s/apps/a"; app "$s/apps/b"; app "$s/apps/c"; app "$s/apps/d"
  printf 'not json' > "$s/apps/a/.move-requested"
  printf '{"to":"conversation"}' > "$s/apps/b/.move-requested"
  printf '{"to":"project","project":"../x"}' > "$s/apps/c/.move-requested"
  printf '{"to":"project","project":"archive"}' > "$s/apps/d/.move-requested"
  ( source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_eq "" "$(cat "$s/calls")" "nothing run"
  for x in a b c d; do assert_absent "$s/apps/$x/.move-requested" "$x dropped"; done
  rm -rf "$s"
}

test_archived_project_apps_are_ignored_by_move_scan() {
  local s; s=$(setup)
  app "$s/projects/archive/old/apps/gone"
  printf '{"to":"sidebar"}' > "$s/projects/archive/old/apps/gone/.move-requested"
  ( source_supervisor "$s"; scan_app_move_requested_sentinels >/dev/null 2>&1 )
  assert_eq "" "$(cat "$s/calls")" "archived project's app not moved"
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
run_test test_move_sidebar_app_into_project
run_test test_move_project_app_to_sidebar_with_users
run_test test_move_conversation_app_tells_its_agent
run_test test_failed_move_records_reason_and_does_not_tell_agent
run_test test_bad_requests_are_dropped
run_test test_archived_project_apps_are_ignored_by_move_scan
run_test test_retire_archived_project_apps

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
