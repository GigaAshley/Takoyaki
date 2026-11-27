#!/usr/bin/env bash
# shellcheck shell=bash
#
# Test driver for substrate/scripts/fleet-change — the machine's front door:
#   - requests are numbered in arrival order and carried out one at a time
#   - the same request id sent twice is done once
#   - app-move: runs move-app.sh; refuses moves into/out of archived projects
#   - project-contents / project-archive: the machine decides what a project
#     archive takes; a stale confirm list is refused with the current contents
#   - a request left running when the listener stopped is carried on
#
# move-app.sh is a stub that moves the folder (move-app.sh itself is covered by
# app-units.test.sh). app-units.sh is a stub: `find` mirrors the real lookup,
# `port` answers for apps with a unit file in $s/units, stash/uninstall record.
#
# Usage: bash substrate/scripts/tests/fleet-change.test.sh   (from repo root)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FC="${FLEET_CHANGE:-$REPO_ROOT/substrate/scripts/fleet-change}"
[ -f "$FC" ] || { printf 'FATAL: fleet-change not found at %s\n' "$FC" >&2; exit 1; }

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
  mkdir -p "$s/fleet/identities" "$s/fleet/apps" "$s/fleet/apps-archive" "$s/fleet/projects" "$s/units"
  cat > "$s/move-app.sh" <<STUB
#!/usr/bin/env bash
printf 'move %s\n' "\$*" >> "$s/calls"
[ "\${STUB_MOVE_RC:-0}" = 0 ] || { echo "[move-app] ERROR: stub refused"; exit 1; }
slug="\$1"; kind="\$2"
src="\$(bash "$s/app-units.sh" find "\$slug")"
if [ "\$kind" = project ]; then dest="$s/fleet/projects/\$3/apps/\$slug"; else dest="$s/fleet/apps/\$slug"; fi
mkdir -p "\$(dirname "\$dest")"; mv "\$src" "\$dest"
STUB
  cat > "$s/app-units.sh" <<STUB
#!/usr/bin/env bash
F="$s/fleet"
case "\$1" in
  find)
    [ -d "\$F/apps/\$2" ] && { echo "\$F/apps/\$2"; exit 0; }
    for d in "\$F"/identities/*/apps/"\$2" "\$F"/projects/*/apps/"\$2"; do
      case "\$d" in "\$F"/projects/archive/*) continue ;; esac
      [ -d "\$d" ] && { echo "\$d"; exit 0; }
    done
    exit 1 ;;
  port) [ -f "$s/units/app-\$2.socket" ] && echo 9100; exit 0 ;;
  stash|uninstall) printf 'units %s\n' "\$*" >> "$s/calls"; [ "\$1" = uninstall ] && rm -f "$s/units/app-\$2.socket"; exit 0 ;;
esac
STUB
  chmod +x "$s/move-app.sh" "$s/app-units.sh"
  : > "$s/calls"
  printf '%s' "$s"
}

fc() {
  local s="$1"; shift
  FLEET_CHANGE_FLEET_DIR="$s/fleet" FLEET_CHANGE_APP_UNITS="$s/app-units.sh" FLEET_CHANGE_MOVE_APP="$s/move-app.sh" \
    FLEET_CHANGE_POLL_S=0.02 python3 "$FC" "$@"
}
serve_once() { fc "$1" serve --until-idle >> "$1/serve.log" 2>&1; }
field() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]);
for k in sys.argv[2].split("."): d = d[int(k)] if isinstance(d, list) else d.get(k)
print(d if not isinstance(d, (list, dict)) else json.dumps(d, sort_keys=True))' "$1" "$2"; }

project() {  # project <s> <slug> <displayName> [parent]
  mkdir -p "$1/fleet/projects/$2"
  { printf -- '---\ndisplayName: %s\n' "$3"; [ -n "${4:-}" ] && printf 'parent: %s\n' "$4"; printf -- '---\n'; } > "$1/fleet/projects/$2/project.md"
}
app() { mkdir -p "$1"; printf '{"title": "%s"}\n' "${2:-Tally}" > "$1/app.json"; }
agent() {  # agent <s> <name> <project>
  mkdir -p "$1/fleet/identities/$2"
  printf -- '---\nroles: []\ntask: "Doing %s"\nproject: %s\n---\n' "$2" "$3" > "$1/fleet/identities/$2/$2.md"
}

# The Aither sequence: two apps moved out of a sub-project, then the sub-project archived.
# In arrival order: both moves happen first, the contents question sees them gone, the
# archive takes only what's left.
test_aither_sequence_runs_in_click_order() {
  local s; s=$(setup)
  project "$s" active "Active"; project "$s" aither "Aither Intelligence" active
  app "$s/fleet/projects/aither/apps/ai-spend" "AI Spend"; app "$s/fleet/projects/aither/apps/ai-cost" "AI Cost"
  fc "$s" submit app-move '{"slug":"ai-spend","to":"project","project":"active"}' --id m1 --wait 0 >/dev/null
  fc "$s" submit app-move '{"slug":"ai-cost","to":"project","project":"active"}' --id m2 --wait 0 >/dev/null
  fc "$s" submit project-contents '{"slug":"aither"}' --id c1 --wait 0 >/dev/null
  serve_once "$s"
  local c; c=$(fc "$s" status c1)
  assert_eq done "$(field "$c" state)" "contents done"
  assert_eq "[]" "$(field "$c" result.apps)" "contents see the apps gone"
  fc "$s" submit project-archive '{"slug":"aither","expected":{"projects":["aither"],"agents":[],"apps":[]}}' --id a1 --wait 0 >/dev/null
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status m1)" state)" "move 1"
  assert_eq done "$(field "$(fc "$s" status a1)" state)" "archive"
  assert_exists "$s/fleet/projects/active/apps/ai-spend/app.json" "ai-spend in Active"
  assert_exists "$s/fleet/projects/active/apps/ai-cost/app.json" "ai-cost in Active"
  assert_exists "$s/fleet/projects/archive/aither/project.md" "aither archived"
  assert_absent "$s/fleet/projects/archive/aither/apps/ai-spend" "nothing went with it"
  rm -rf "$s"
}

test_archive_first_then_move_out_is_refused() {
  local s; s=$(setup)
  project "$s" active "Active"; project "$s" aither "Aither Intelligence" active
  app "$s/fleet/projects/aither/apps/ai-spend" "AI Spend"
  fc "$s" submit project-archive '{"slug":"aither","expected":{"projects":["aither"],"agents":[],"apps":["ai-spend"]}}' --id a1 --wait 0 >/dev/null
  fc "$s" submit app-move '{"slug":"ai-spend","to":"project","project":"active"}' --id m1 --wait 0 >/dev/null
  serve_once "$s"
  local m; m=$(fc "$s" status m1)
  assert_eq refused "$(field "$m" state)" "move refused"
  assert_eq archived "$(field "$m" code)" "code"
  assert_eq 'it was archived with the project "Aither Intelligence"' "$(field "$m" reason)" "reason"
  assert_exists "$s/fleet/projects/archive/aither/apps/ai-spend/app.json" "app archived with it"
  rm -rf "$s"
}

test_move_into_archived_project_is_refused() {
  local s; s=$(setup)
  project "$s" garden "Garden"; app "$s/fleet/apps/tally"
  fc "$s" submit project-archive '{"slug":"garden","expected":{"projects":["garden"],"agents":[],"apps":[]}}' --id a1 --wait 0 >/dev/null
  fc "$s" submit app-move '{"slug":"tally","to":"project","project":"garden"}' --id m1 --wait 0 >/dev/null
  serve_once "$s"
  local m; m=$(fc "$s" status m1)
  assert_eq project_archived "$(field "$m" code)" "code"
  assert_eq '"Garden" is archived' "$(field "$m" reason)" "reason"
  assert_exists "$s/fleet/apps/tally/app.json" "app stayed put"
  assert_eq "" "$(grep '^move' "$s/calls")" "move-app.sh never ran"
  rm -rf "$s"
}

test_stale_confirm_list_is_refused_with_current_contents() {
  local s; s=$(setup)
  project "$s" garden "Garden"; agent "$s" finch garden
  fc "$s" submit project-archive '{"slug":"garden","expected":{"projects":["garden"],"agents":[],"apps":[]}}' --id a1 --wait 0 >/dev/null
  serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq refused "$(field "$a" state)" "refused"
  assert_eq contents_changed "$(field "$a" code)" "code"
  assert_eq finch "$(field "$a" result.agents.0.name)" "current list returned"
  assert_exists "$s/fleet/projects/garden/project.md" "nothing archived"
  assert_absent "$s/fleet/identities/finch/.archive-requested" "agent untouched"
  rm -rf "$s"
}

test_archive_takes_subtree_agents_and_stops_apps() {
  local s; s=$(setup)
  project "$s" garden "Garden"; project "$s" beds "Beds" garden; project "$s" other "Other"
  agent "$s" finch beds; agent "$s" wren other
  app "$s/fleet/projects/beds/apps/tally"; : > "$s/units/app-tally.socket"
  local c; c=$(fc "$s" submit project-contents '{"slug":"garden"}' --id c1 --wait 0)
  serve_once "$s"; c=$(fc "$s" status c1)
  assert_eq '["beds", "garden"]' "$(python3 -c 'import json,sys; print(json.dumps(sorted(p["slug"] for p in json.loads(sys.argv[1])["result"]["projects"])))' "$c")" "subtree"
  fc "$s" submit project-archive '{"slug":"garden","expected":{"projects":["garden","beds"],"agents":["finch"],"apps":["tally"]}}' --id a1 --wait 0 >/dev/null
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status a1)" state)" "archive done"
  assert_exists "$s/fleet/projects/archive/garden/project.md" "garden archived"
  assert_exists "$s/fleet/projects/archive/beds/apps/tally/app.json" "beds archived with its app"
  assert_exists "$s/fleet/identities/finch/.archive-requested" "agent in sub-project archived"
  assert_absent "$s/fleet/identities/wren/.archive-requested" "agent elsewhere untouched"
  assert_exists "$s/fleet/projects/other/project.md" "other project untouched"
  grep -q 'units uninstall tally' "$s/calls" || fail "app units removed"
  rm -rf "$s"
}

test_archive_collision_gets_suffix() {
  local s; s=$(setup)
  project "$s" garden "Garden"; mkdir -p "$s/fleet/projects/archive/garden"
  fc "$s" submit project-archive '{"slug":"garden","expected":{"projects":["garden"],"agents":[],"apps":[]}}' --id a1 --wait 0 >/dev/null
  serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq done "$(field "$a" state)" "done"
  case "$(field "$a" result.projects.0.archivedAs)" in garden-2*Z) ;; *) fail "suffixed name: $a" ;; esac
  rm -rf "$s"
}

test_same_id_twice_is_done_once() {
  local s; s=$(setup)
  project "$s" garden "Garden"; app "$s/fleet/apps/tally"
  fc "$s" submit app-move '{"slug":"tally","to":"project","project":"garden"}' --id m1 --wait 0 >/dev/null
  fc "$s" submit app-move '{"slug":"tally","to":"project","project":"garden"}' --id m1 --wait 0 >/dev/null
  serve_once "$s"
  local again; again=$(fc "$s" submit app-move '{"slug":"tally","to":"project","project":"garden"}' --id m1 --wait 1)
  assert_eq done "$(field "$again" state)" "outcome returned to the repeat"
  assert_eq 1 "$(grep -c '^move' "$s/calls")" "move-app.sh ran once"
  rm -rf "$s"
}

test_numbers_follow_arrival_order() {
  local s; s=$(setup)
  project "$s" garden "Garden"
  fc "$s" submit project-contents '{"slug":"garden"}' --id first --wait 0 >/dev/null
  fc "$s" submit project-contents '{"slug":"garden"}' --id second --wait 0 >/dev/null
  serve_once "$s"
  assert_eq 1 "$(field "$(fc "$s" status first)" seq)" "first"
  assert_eq 2 "$(field "$(fc "$s" status second)" seq)" "second"
  rm -rf "$s"
}

test_waiting_request_reports_queued_or_received() {
  local s; s=$(setup)
  project "$s" garden "Garden"
  local r; r=$(fc "$s" submit project-contents '{"slug":"garden"}' --id w1 --wait 0.1)
  assert_eq received "$(field "$r" state)" "not taken in yet"
  assert_eq unknown "$(field "$(fc "$s" status nope)" state)" "unknown id"
  rm -rf "$s"
}

test_failed_move_reports_why() {
  local s; s=$(setup)
  project "$s" garden "Garden"; app "$s/fleet/apps/tally"
  fc "$s" submit app-move '{"slug":"tally","to":"project","project":"garden"}' --id m1 --wait 0 >/dev/null
  STUB_MOVE_RC=1 serve_once "$s"
  local m; m=$(fc "$s" status m1)
  assert_eq failed "$(field "$m" state)" "failed"
  assert_eq "stub refused" "$(field "$m" reason)" "reason"
  rm -rf "$s"
}

test_conversation_app_owner_is_told() {
  local s; s=$(setup)
  agent "$s" finch ""; app "$s/fleet/identities/finch/apps/tally" "Tally"
  fc "$s" submit app-move '{"slug":"tally","to":"sidebar","users":null}' --id m1 --wait 0 >/dev/null
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status m1)" state)" "done"
  grep -q 'move tally sidebar --everyone' "$s/calls" || fail "everyone flag passed"
  grep -rqs 'was moved to the sidebar' "$s/fleet/identities/finch/inbox" || fail "owner told"
  rm -rf "$s"
}

test_unknown_kind_written_by_hand_is_refused() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/.changes/incoming"
  printf '{"id":"x1","kind":"fly","args":{}}' > "$s/fleet/.changes/incoming/00000000000000000001-x1.json"
  serve_once "$s"
  assert_eq unknown_kind "$(field "$(fc "$s" status x1)" code)" "refused"
  rm -rf "$s"
}

test_running_request_is_carried_on_after_restart() {
  local s; s=$(setup)
  project "$s" garden "Garden"; project "$s" beds "Beds" garden; agent "$s" finch garden
  # A listener stopped after archiving beds but before garden.
  mkdir -p "$s/fleet/.changes/journal" "$s/fleet/projects/archive"
  mv "$s/fleet/projects/beds" "$s/fleet/projects/archive/beds"
  printf '{"seq":4,"id":"a1","kind":"project-archive","args":{"slug":"garden","expected":{"projects":["garden","beds"],"agents":["finch"],"apps":[]}},"state":"running","plan":{"projects":["garden","beds"],"agents":["finch"],"apps":[],"archivedAs":{"beds":"beds"}}}' \
    > "$s/fleet/.changes/journal/0000000004-a1.json"
  serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq done "$(field "$a" state)" "finished"
  assert_exists "$s/fleet/projects/archive/garden/project.md" "garden archived"
  assert_exists "$s/fleet/identities/finch/.archive-requested" "agent handed over"
  grep -q 'carried on after a restart' "$s/serve.log" || fail "logged as carried on"
  rm -rf "$s"
}

test_change_lock_is_held_while_a_request_runs() {
  local s; s=$(setup)
  project "$s" garden "Garden"
  fc "$s" submit project-contents '{"slug":"garden"}' --id c1 --wait 0 >/dev/null
  # Someone else (the supervisor) holds the change lock: the request waits for it.
  ( exec 9>"$s/fleet/.change-lock"; flock -x 9; sleep 1.5 ) &
  local holder=$!
  sleep 0.3
  local t0; t0=$(date +%s%N)
  serve_once "$s"
  local ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  wait "$holder"
  [ "$ms" -ge 900 ] || fail "request ran without the lock (${ms}ms)"
  assert_eq done "$(field "$(fc "$s" status c1)" state)" "done after the lock was free"
  rm -rf "$s"
}

printf 'fleet-change tests\n'
run_test test_aither_sequence_runs_in_click_order
run_test test_archive_first_then_move_out_is_refused
run_test test_move_into_archived_project_is_refused
run_test test_stale_confirm_list_is_refused_with_current_contents
run_test test_archive_takes_subtree_agents_and_stops_apps
run_test test_archive_collision_gets_suffix
run_test test_same_id_twice_is_done_once
run_test test_numbers_follow_arrival_order
run_test test_waiting_request_reports_queued_or_received
run_test test_failed_move_reports_why
run_test test_conversation_app_owner_is_told
run_test test_unknown_kind_written_by_hand_is_refused
run_test test_running_request_is_carried_on_after_restart
run_test test_change_lock_is_held_while_a_request_runs

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
