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
#   - agent / role archives are claimed at once and finished by the supervisor;
#     agent un-archives are accepted and finished by it; role and app archives
#     and un-archives are carried out here
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
  stash|restore|install) printf 'units %s\n' "\$*" >> "$s/calls"; exit 0 ;;
  uninstall)
    printf 'units %s\n' "\$*" >> "$s/calls"
    [ "\$2" = "\${STUB_UNINSTALL_FAILS:-}" ] && { echo "unit busy"; exit 1; }
    rm -f "$s/units/app-\$2.socket"; exit 0 ;;
esac
STUB
  cat > "$s/archive-app.sh" <<STUB
#!/usr/bin/env bash
printf 'archive-app %s\n' "\$*" >> "$s/calls"
mkdir -p "$s/fleet/apps-archive"; mv "$s/fleet/apps/\$1" "$s/fleet/apps-archive/\$1"
STUB
  cat > "$s/systemctl" <<STUB
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$s/calls"
STUB
  chmod +x "$s/move-app.sh" "$s/app-units.sh" "$s/archive-app.sh" "$s/systemctl"
  : > "$s/calls"
  printf '%s' "$s"
}

fc() {
  local s="$1"; shift
  FLEET_CHANGE_FLEET_DIR="$s/fleet" FLEET_CHANGE_APP_UNITS="$s/app-units.sh" FLEET_CHANGE_MOVE_APP="$s/move-app.sh" \
    FLEET_CHANGE_ARCHIVE_APP="$s/archive-app.sh" FLEET_CHANGE_UNIT_DIR="$s/units" FLEET_CHANGE_SYSTEMCTL="$s/systemctl" \
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
agent() {  # agent <s> <name> <project> [roles]
  mkdir -p "$1/fleet/identities/$2"
  printf -- '---\nroles: [%s]\ntask: "Doing %s"\nproject: %s\n---\n' "${4:-}" "$2" "$3" > "$1/fleet/identities/$2/$2.md"
}
role() { mkdir -p "$1/fleet/roles/$2"; printf -- '---\ndisplayName: %s\n---\n' "${3:-$2}" > "$1/fleet/roles/$2/$2.md"; }
archived_agent() {  # archived_agent <s> <name> [roles]
  mkdir -p "$1/fleet/identities-archive/$2"
  printf -- '---\nroles: [%s]\n---\n' "${3:-}" > "$1/fleet/identities-archive/$2/$2.md"
}
submit() { fc "$1" submit "$2" "$3" --id "$4" --wait 0 >/dev/null; }

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
  assert_absent "$s/fleet/identities/finch/.archiving" "agent untouched"
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
  assert_exists "$s/fleet/identities/finch/.archiving" "agent in sub-project claimed"
  assert_absent "$s/fleet/identities/wren/.archiving" "agent elsewhere untouched"
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
  assert_exists "$s/fleet/identities/finch/.archiving" "agent claimed"
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

test_app_that_wont_stop_leaves_the_project_as_it_was() {
  local s; s=$(setup)
  project "$s" garden "Garden"; project "$s" beds "Beds" garden
  app "$s/fleet/projects/beds/apps/aaa"; : > "$s/units/app-aaa.socket"
  app "$s/fleet/projects/garden/apps/zzz"; : > "$s/units/app-zzz.socket"
  fc "$s" submit project-archive '{"slug":"garden","expected":{"projects":["garden","beds"],"agents":[],"apps":["aaa","zzz"]}}' --id a1 --wait 0 >/dev/null
  STUB_UNINSTALL_FAILS=aaa serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq failed "$(field "$a" state)" "failed"
  assert_eq app_stop_failed "$(field "$a" code)" "code"
  assert_exists "$s/fleet/projects/beds/project.md" "sub-project not archived"
  assert_exists "$s/fleet/projects/garden/project.md" "project not archived"
  grep -q 'units restore zzz' "$s/calls" || fail "the app already stopped is started again: $(cat "$s/calls")"
  rm -rf "$s"
}

test_carry_on_refuses_what_appeared_since() {
  local s; s=$(setup)
  project "$s" garden "Garden"; project "$s" beds "Beds" garden
  mkdir -p "$s/fleet/.changes/journal" "$s/fleet/projects/archive"
  mv "$s/fleet/projects/beds" "$s/fleet/projects/archive/beds"
  agent "$s" newcomer garden
  printf '{"seq":2,"id":"a1","kind":"project-archive","args":{"slug":"garden","expected":{"projects":["garden","beds"],"agents":[],"apps":[]}},"state":"running","plan":{"projects":["garden","beds"],"agents":[],"apps":[],"archivedAs":{"beds":"beds"}}}' \
    > "$s/fleet/.changes/journal/0000000002-a1.json"
  serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq changed_during_restart "$(field "$a" code)" "refused to take the newcomer"
  assert_exists "$s/fleet/projects/garden/project.md" "garden left live"
  assert_absent "$s/fleet/identities/newcomer/.archiving" "newcomer untouched"
  rm -rf "$s"
}

test_move_cut_off_after_the_folder_moved_is_finished() {
  local s; s=$(setup)
  project "$s" garden "Garden"
  app "$s/fleet/projects/garden/apps/tally"   # folder already moved, units not back yet
  mkdir -p "$s/fleet/.changes/journal"
  printf '{"seq":3,"id":"m1","kind":"app-move","args":{"slug":"tally","to":"project","project":"garden"},"state":"running","plan":{"port":9123}}' \
    > "$s/fleet/.changes/journal/0000000003-m1.json"
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status m1)" state)" "done"
  grep -q "units install tally $s/fleet/projects/garden/apps/tally 9123" "$s/calls" || fail "started again on its port: $(cat "$s/calls")"
  rm -rf "$s"
}

# ---- archive and un-archive of agents, roles and apps ----

test_agent_archive_claims_at_once() {
  local s; s=$(setup)
  agent "$s" finch ""; mkdir -p "$s/fleet/identities/finch/apps/tally"; app "$s/fleet/identities/finch/apps/tally"
  : > "$s/fleet/identities/finch/.archive-requested"
  submit "$s" agent-archive '{"name":"finch"}' a1
  submit "$s" app-move '{"slug":"tally","to":"sidebar","users":null}' m1
  serve_once "$s"
  local a; a=$(fc "$s" status a1)
  assert_eq done "$(field "$a" state)" "archive done at the claim"
  assert_eq '["finch"]' "$(field "$a" finishing.pending)" "still finishing"
  assert_eq a1 "$(field "$(cat "$s/fleet/identities/finch/.archiving")" id)" "claim carries the request"
  assert_absent "$s/fleet/identities/finch/.archive-requested" "old note dropped"
  assert_exists "$s/fleet/identities/.supervisor-wake" "supervisor woken"
  local m; m=$(fc "$s" status m1)
  assert_eq being_archived "$(field "$m" code)" "its app can't be moved out"
  assert_exists "$s/fleet/identities/finch/apps/tally/app.json" "app stayed"
  # Once the supervisor has moved it, the same status reads as finished.
  mkdir -p "$s/fleet/identities-archive"; mv "$s/fleet/identities/finch" "$s/fleet/identities-archive/finch"
  assert_eq "None" "$(field "$(fc "$s" status a1)" finishing)" "finished"
  rm -rf "$s"
}

test_agent_archive_refusals() {
  local s; s=$(setup)
  agent "$s" finch ""; agent "$s" wren ""; : > "$s/fleet/identities/wren/.pinned"
  archived_agent "$s" finch
  submit "$s" agent-archive '{"name":"finch"}' a1
  submit "$s" agent-archive '{"name":"wren","dormant":true}' a2
  submit "$s" agent-archive '{"name":"nobody"}' a3
  serve_once "$s"
  assert_eq archive_slot_taken "$(field "$(fc "$s" status a1)" code)" "slot taken"
  assert_eq guarded "$(field "$(fc "$s" status a2)" code)" "sleep sweep respects pins"
  assert_eq not_found "$(field "$(fc "$s" status a3)" code)" "unknown agent"
  assert_absent "$s/fleet/identities/finch/.archiving" "nothing claimed"
  assert_absent "$s/fleet/identities/wren/.archiving" "nothing claimed"
  rm -rf "$s"
}

test_stuck_archive_says_why() {
  local s; s=$(setup)
  agent "$s" finch ""
  submit "$s" agent-archive '{"name":"finch"}' a1; serve_once "$s"
  python3 - "$s/fleet/identities/finch/.archiving" <<'PY'
import json, sys, time
p = sys.argv[1]; c = json.load(open(p))
c.update(failing_since=time.time() - 700, last_error="couldn't switch the chat account off")
json.dump(c, open(p, "w"))
PY
  assert_eq "couldn't switch the chat account off" "$(field "$(fc "$s" status a1)" finishing.stuck.finch)" "stuck reason"
  rm -rf "$s"
}

test_role_archive_uses_the_machines_list() {
  local s; s=$(setup)
  role "$s" eng "Engineer"; agent "$s" ann "" eng; agent "$s" bob "" "ops, eng"; agent "$s" cat "" ops
  submit "$s" role-contents '{"name":"eng"}' c1; serve_once "$s"
  assert_eq '["ann", "bob"]' "$(python3 -c 'import json,sys; print(json.dumps([a["name"] for a in json.loads(sys.argv[1])["result"]["agents"]]))' "$(fc "$s" status c1)")" "who holds it"
  submit "$s" role-archive '{"name":"eng","expected":{"agents":["ann"]}}' r1; serve_once "$s"
  local r; r=$(fc "$s" status r1)
  assert_eq contents_changed "$(field "$r" code)" "stale list refused"
  assert_absent "$s/fleet/identities/ann/.archiving" "nothing claimed"
  submit "$s" role-archive '{"name":"eng","expected":{"agents":["bob","ann"]}}' r2; serve_once "$s"
  r=$(fc "$s" status r2)
  assert_eq done "$(field "$r" state)" "archived"
  assert_eq '["ann", "bob", "eng"]' "$(field "$r" finishing.pending)" "role and agents finishing"
  assert_exists "$s/fleet/identities/ann/.archiving" "ann claimed"
  assert_exists "$s/fleet/identities/bob/.archiving" "bob claimed"
  assert_absent "$s/fleet/identities/cat/.archiving" "cat untouched"
  assert_eq '["ann", "bob"]' "$(field "$(cat "$s/fleet/roles/eng/.archiving")" agents)" "role claim lists its agents"
  rm -rf "$s"
}

test_role_archive_refused_while_an_agent_is_coming_back() {
  local s; s=$(setup)
  role "$s" eng; archived_agent "$s" ann eng
  submit "$s" agent-unarchive '{"name":"ann"}' u1
  submit "$s" role-archive '{"name":"eng","expected":{"agents":[]}}' r1
  serve_once "$s"
  local r; r=$(fc "$s" status r1)
  assert_eq agent_returning "$(field "$r" code)" "refused"
  assert_eq "'ann' is still being un-archived; try again in a minute" "$(field "$r" reason)" "names the agent"
  assert_absent "$s/fleet/roles/eng/.archiving" "nothing archived"
  rm -rf "$s"
}

test_agent_unarchive_is_finished_in_the_background() {
  local s; s=$(setup)
  role "$s" eng; archived_agent "$s" ann eng; archived_agent "$s" zed gone
  submit "$s" agent-unarchive '{"name":"ann"}' u1
  submit "$s" agent-unarchive '{"name":"ann"}' u2
  submit "$s" agent-unarchive '{"name":"zed"}' u3
  serve_once "$s"
  local u; u=$(fc "$s" status u1)
  assert_eq running "$(field "$u" state)" "accepted, not done"
  assert_eq finishing "$(field "$u" stage)" "finishing in the background"
  assert_eq '["u1", "u2"]' "$(field "$(cat "$s/fleet/.changes/returning/ann.json")" ids)" "both clicks wait on one un-archive"
  u=$(fc "$s" status u3)
  assert_eq missing_roles "$(field "$u" code)" "missing role refused at once"
  assert_eq '["gone"]' "$(field "$u" result.missingRoles)" "names it"
  submit "$s" agent-archive '{"name":"ann"}' a1; serve_once "$s"
  assert_eq returning "$(field "$(fc "$s" status a1)" code)" "can't be archived while coming back"
  fc "$s" finish u1 done --result '{"name":"ann"}' >/dev/null
  assert_eq done "$(field "$(fc "$s" status u1)" state)" "finished by the supervisor"
  rm -rf "$s"
}

test_agent_unarchive_waits_for_an_unfinished_archive() {
  local s; s=$(setup)
  agent "$s" ann ""
  submit "$s" agent-archive '{"name":"ann"}' a1
  submit "$s" agent-unarchive '{"name":"ann"}' u1
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status a1)" state)" "archive claimed"
  assert_eq running "$(field "$(fc "$s" status u1)" state)" "un-archive accepted, waiting"
  assert_exists "$s/fleet/.changes/returning/ann.json" "held for the supervisor"
  rm -rf "$s"
}

test_role_and_app_unarchive() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/roles-archive/eng"; : > "$s/fleet/roles-archive/eng/.unarchive-requested"
  mkdir -p "$s/fleet/roles/ops" "$s/fleet/roles-archive/ops"
  app "$s/fleet/apps-archive/tally"; printf 'ListenStream=127.0.0.1:9200\n' > "$s/fleet/apps-archive/tally/app-tally.socket.archived"
  app "$s/fleet/apps-archive/old"; printf 'Environment=PORT=9300\n' > "$s/fleet/apps-archive/old/app-old.service.archived"
  app "$s/fleet/apps-archive/clash"; printf 'ListenStream=127.0.0.1:9400\n' > "$s/fleet/apps-archive/clash/app-clash.socket.archived"
  printf 'ListenStream=127.0.0.1:9400\n' > "$s/units/app-other.socket"
  app "$s/fleet/apps-archive/clash2"; printf 'ListenStream=127.0.0.1:9500\n' > "$s/fleet/apps-archive/clash2/app-clash2.socket.archived"
  printf 'Environment=PORT=9500\n' > "$s/units/app-legacy.service"
  app "$s/fleet/apps-archive/nostash"
  submit "$s" role-unarchive '{"name":"eng"}' r1
  submit "$s" role-unarchive '{"name":"ops"}' r2
  submit "$s" app-unarchive '{"slug":"tally"}' p1
  submit "$s" app-unarchive '{"slug":"old"}' p2
  submit "$s" app-unarchive '{"slug":"clash"}' p3
  submit "$s" app-unarchive '{"slug":"clash2"}' p4
  submit "$s" app-unarchive '{"slug":"nostash"}' p5
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status r1)" state)" "role back"
  assert_exists "$s/fleet/roles/eng" "role folder live"
  assert_absent "$s/fleet/roles/eng/.unarchive-requested" "note dropped"
  assert_eq name_collision "$(field "$(fc "$s" status r2)" code)" "live role in the way"
  assert_eq 9200 "$(field "$(fc "$s" status p1)" result.port)" "app back on its port"
  grep -q "units restore tally $s/fleet/apps/tally" "$s/calls" || fail "units restored: $(cat "$s/calls")"
  assert_eq done "$(field "$(fc "$s" status p2)" state)" "old-style app back"
  assert_exists "$s/units/app-old.service" "its unit reinstalled"
  grep -q "systemctl --user enable --now app-old.service" "$s/calls" || fail "started: $(cat "$s/calls")"
  assert_eq port_in_use "$(field "$(fc "$s" status p3)" code)" "port taken refused"
  assert_exists "$s/fleet/apps-archive/clash" "stays archived"
  assert_eq port_in_use "$(field "$(fc "$s" status p4)" code)" "port held by an old-style app refused"
  assert_eq no_stash "$(field "$(fc "$s" status p5)" code)" "no saved units refused"
  if grep -q "units restore old" "$s/calls"; then fail "old-style app went through app-units.sh"; fi
  rm -rf "$s"
}

test_app_archive() {
  local s; s=$(setup)
  app "$s/fleet/apps/tally"; : > "$s/fleet/apps/tally/.archive-requested"
  project "$s" garden "Garden"; app "$s/fleet/projects/garden/apps/beds"
  submit "$s" app-archive '{"slug":"tally"}' p1
  submit "$s" app-archive '{"slug":"beds"}' p2
  submit "$s" app-archive '{"slug":"tally"}' p3
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status p1)" state)" "archived"
  assert_exists "$s/fleet/apps-archive/tally/app.json" "in the archive"
  assert_absent "$s/fleet/apps-archive/tally/.archive-requested" "note dropped"
  assert_eq project_app "$(field "$(fc "$s" status p2)" code)" "a project's app goes with its project"
  assert_eq True "$(field "$(fc "$s" status p3)" result.alreadyArchived)" "second click: already archived"
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
run_test test_app_that_wont_stop_leaves_the_project_as_it_was
run_test test_carry_on_refuses_what_appeared_since
run_test test_move_cut_off_after_the_folder_moved_is_finished
run_test test_agent_archive_claims_at_once
run_test test_agent_archive_refusals
run_test test_stuck_archive_says_why
run_test test_role_archive_uses_the_machines_list
run_test test_role_archive_refused_while_an_agent_is_coming_back
run_test test_agent_unarchive_is_finished_in_the_background
run_test test_agent_unarchive_waits_for_an_unfinished_archive
run_test test_role_and_app_unarchive
run_test test_app_archive

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
