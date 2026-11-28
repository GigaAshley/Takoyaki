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

test_project_archive_tells_the_people_whose_agents_it_took() {
  local s; s=$(setup)
  project "$s" shared "Shared"
  agent "$s" bea shared; printf -- '---\nroles: []\nproject: shared\nusers:\n  - bob\n---\n' > "$s/fleet/identities/bea/bea.md"
  agent "$s" ann shared; printf -- '---\nroles: []\nproject: shared\nusers:\n  - ann\n---\n' > "$s/fleet/identities/ann/ann.md"
  agent "$s" all shared
  # Seen only through its role (cyd's people are the role's): told too.
  mkdir -p "$s/fleet/roles/ops"; printf -- '---\ndisplayName: Ops\nusers:\n  - cyd\n---\n' > "$s/fleet/roles/ops/ops.md"
  agent "$s" rolo shared ops
  fc "$s" submit project-archive '{"slug":"shared","asker":"ann","expected":{"projects":["shared"],"agents":["all","ann","bea","rolo"],"apps":[]}}' --id p1 --by user:u_Ann --wait 0 >/dev/null
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status p1)" state)" "archived"
  local n="$s/fleet/.changes/notices"
  assert_eq 2 "$(ls "$n" | grep -c '^p1\.')" "two notices: bea's people and rolo's (through its role)"
  assert_eq '["cyd"]' "$(field "$(cat "$n/p1.1.json")" audience)" "rolo's people are its role's"
  local f="$n/p1.0.json"
  assert_eq taken "$(field "$(cat "$f")" state)" "a taken notice"
  assert_eq bea "$(field "$(cat "$f")" args.name)" "about bea"
  assert_eq '["bob"]' "$(field "$(cat "$f")" audience)" "for bob"
  assert_eq 'it was archived with the project "Shared" by ann' "$(field "$(cat "$f")" reason)" "which project, and who"
  # Not knowing who archived it tells nobody.
  project "$s" two "Two"; agent "$s" cy two; printf -- '---\nroles: []\nproject: two\nusers:\n  - bob\n---\n' > "$s/fleet/identities/cy/cy.md"
  fc "$s" submit project-archive '{"slug":"two","expected":{"projects":["two"],"agents":["cy"],"apps":[]}}' --id p2 --wait 0 >/dev/null
  serve_once "$s"
  assert_eq 0 "$(ls "$n" | grep -c '^p2\.')" "no asker, no notice"
  rm -rf "$s"
}

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

test_group_archives_refused_when_an_agents_slot_is_taken() {
  local s; s=$(setup)
  role "$s" eng; agent "$s" bob "" eng; archived_agent "$s" bob
  project "$s" garden "Garden"; agent "$s" carol garden; archived_agent "$s" carol
  submit "$s" role-archive '{"name":"eng","expected":{"agents":["bob"]}}' r1
  submit "$s" project-archive '{"slug":"garden","expected":{"projects":["garden"],"agents":["carol"],"apps":[]}}' p1
  serve_once "$s"
  assert_eq archive_slot_taken "$(field "$(fc "$s" status r1)" code)" "role archive refused"
  assert_eq archive_slot_taken "$(field "$(fc "$s" status p1)" code)" "project archive refused"
  assert_absent "$s/fleet/identities/bob/.archiving" "bob not claimed"
  assert_absent "$s/fleet/roles/eng/.archiving" "role not claimed"
  assert_absent "$s/fleet/identities/carol/.archiving" "carol not claimed"
  assert_exists "$s/fleet/projects/garden/project.md" "project not archived"
  rm -rf "$s"
}

test_sleep_sweep_refused_when_the_agent_woke() {
  local s; s=$(setup)
  agent "$s" wren ""; touch -d '2025-01-01' "$s/fleet/identities/wren"
  agent "$s" finch ""; mkdir -p "$s/fleet/identities/finch/relay-state"; : > "$s/fleet/identities/finch/relay-state/since"
  touch -d '2025-01-01' "$s/fleet/identities/finch"
  submit "$s" agent-archive '{"name":"wren","dormant":true,"idleFor":15552000}' a1
  submit "$s" agent-archive '{"name":"finch","dormant":true,"idleFor":15552000}' a2
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status a1)" state)" "still idle: archived"
  assert_eq not_idle "$(field "$(fc "$s" status a2)" code)" "talked to since: refused"
  rm -rf "$s"
}

test_app_unarchive_start_is_tried_again() {
  local s; s=$(setup)
  app "$s/fleet/apps-archive/old"; printf 'Environment=PORT=9300\n' > "$s/fleet/apps-archive/old/app-old.service.archived"
  cat > "$s/systemctl" <<STUB
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$s/calls"
case "\$*" in *enable*) [ -e "$s/systemd-busy" ] && exit 1 ;; esac
exit 0
STUB
  : > "$s/systemd-busy"
  submit "$s" app-unarchive '{"slug":"old"}' p1; serve_once "$s"
  assert_eq restore_failed "$(field "$(fc "$s" status p1)" code)" "first start failed"
  assert_exists "$s/fleet/apps/old/app-old.service.archived" "saved unit kept for another try"
  rm -f "$s/systemd-busy"
  submit "$s" app-unarchive '{"slug":"old"}' p2; serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status p2)" state)" "second try"
  assert_absent "$s/fleet/apps/old/app-old.service.archived" "saved unit used up once started"
  assert_eq 2 "$(grep -c 'enable --now app-old.service' "$s/calls")" "started again"
  rm -rf "$s"
}

printf 'fleet-change tests\n'
# ---- quick changes: projects and agents ----

limited() {  # limited <s> <slug> <user...>: give a project its own users: list
  local f="$1/fleet/projects/$2/project.md"; shift 2
  python3 - "$f" "$@" <<'PY'
import sys
f, users = sys.argv[1], sys.argv[2:]
t = open(f).read().split("\n")
t.insert(len(t) - 2, "users:\n" + "\n".join("  - " + u for u in users))
open(f, "w").write("\n".join(t))
PY
}

test_project_create_skips_names_with_leftovers() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/projects/archive/garden"; printf -- '---\ndisplayName: Garden\n---\n' > "$s/fleet/projects/archive/garden/project.md"
  agent "$s" finch orchard
  submit "$s" project-create '{"baseSlug":"garden","displayName":"Garden"}' c1
  submit "$s" project-create '{"baseSlug":"orchard","displayName":"Orchard: big"}' c2
  submit "$s" project-create '{"baseSlug":"garden","displayName":"Garden"}' c3
  serve_once "$s"
  assert_eq garden-2 "$(field "$(fc "$s" status c1)" result.slug)" "archived name not reused"
  assert_eq orchard-2 "$(field "$(fc "$s" status c2)" result.slug)" "a name an agent still points at isn't reused"
  assert_eq garden-3 "$(field "$(fc "$s" status c3)" result.slug)" "next free"
  assert_eq 'displayName: "Orchard: big"' "$(sed -n 2p "$s/fleet/projects/orchard-2/project.md")" "name quoted when it must be"
  assert_absent "$s/fleet/projects/garden" "archived slug left alone"
  rm -rf "$s"
}

test_project_create_inside_a_limited_project_shares_it() {
  local s; s=$(setup)
  project "$s" team "Team"; limited "$s" team ana bo
  submit "$s" project-create '{"baseSlug":"sub","displayName":"Sub","parent":"team","asker":"bo","multiUser":true}' c1
  submit "$s" project-create '{"baseSlug":"peek","displayName":"Peek","parent":"team","asker":"cy","multiUser":true}' c2
  submit "$s" project-create '{"baseSlug":"mine","displayName":"Mine","asker":"cy","multiUser":true}' c3
  serve_once "$s"
  assert_eq '["bo", "ana"]' "$(field "$(fc "$s" status c1)" result.users)" "asker first, then the parent's people"
  local c2; c2=$(fc "$s" status c2)
  assert_eq parent_not_found "$(field "$c2" code)" "a hidden parent reads as missing"
  assert_absent "$s/fleet/projects/peek" "nothing made"
  assert_eq '["cy"]' "$(field "$(fc "$s" status c3)" result.users)" "starts shared with the asker"
  rm -rf "$s"
}

test_project_rename_changes_only_its_name() {
  local s; s=$(setup)
  project "$s" team "Team"
  printf -- '---\ndisplayName: Team\nusers:\n  - ana\n# keep me\nmembers: [finch]\n---\nNotes stay.\n' > "$s/fleet/projects/team/project.md"
  submit "$s" project-move '{"slug":"team","parent":null}' m0
  submit "$s" project-rename '{"slug":"team","displayName":"Dream Team","asker":"ana"}' r1
  submit "$s" project-rename '{"slug":"team","displayName":"Nope","asker":"bo"}' r2
  submit "$s" project-rename '{"slug":"gone","displayName":"X"}' r3
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status r1)" state)" "renamed"
  assert_eq "$(printf -- '---\ndisplayName: Dream Team\nusers:\n  - ana\n# keep me\nmembers: [finch]\n---\nNotes stay.')" \
    "$(cat "$s/fleet/projects/team/project.md")" "every other byte kept"
  assert_eq not_found "$(field "$(fc "$s" status r2)" code)" "hidden from bo"
  assert_eq not_found "$(field "$(fc "$s" status r3)" code)" "gone"
  rm -rf "$s"
}

test_project_move_checks_at_its_turn() {
  local s; s=$(setup)
  project "$s" a "A"; project "$s" b "B" a; project "$s" c "C"
  submit "$s" project-move '{"slug":"a","parent":"b"}' m1
  submit "$s" project-archive '{"slug":"c","expected":{"projects":["c"],"agents":[],"apps":[]}}' x1
  submit "$s" project-move '{"slug":"a","parent":"c"}' m2
  submit "$s" project-move '{"slug":"b","parent":null}' m3
  serve_once "$s"
  assert_eq into_itself "$(field "$(fc "$s" status m1)" code)" "not under its own sub-project"
  assert_eq parent_not_found "$(field "$(fc "$s" status m2)" code)" "not under a project archived a moment ago"
  assert_eq done "$(field "$(fc "$s" status m3)" state)" "to top level"
  assert_eq "$(printf -- '---\ndisplayName: B\n---')" "$(cat "$s/fleet/projects/b/project.md")" "parent line gone"
  rm -rf "$s"
}

test_project_move_never_widens_its_audience() {
  local s; s=$(setup)
  project "$s" team "Team"; limited "$s" team ana; project "$s" sub "Sub" team
  submit "$s" project-move '{"slug":"sub","parent":null,"asker":"ana"}' m1
  serve_once "$s"
  local m; m=$(fc "$s" status m1)
  assert_eq '["ana"]' "$(field "$m" result.audienceKept)" "audience kept"
  assert_eq "$(printf -- '---\ndisplayName: Sub\nusers:\n  - ana\n---')" "$(cat "$s/fleet/projects/sub/project.md")" "its own list now"
  rm -rf "$s"
}

test_agent_move_to_a_gone_project_is_refused() {
  local s; s=$(setup)
  project "$s" garden "Garden"; project "$s" orchard "Orchard"; agent "$s" finch ""
  : > "$s/fleet/identities/finch/.pinned"
  submit "$s" project-archive '{"slug":"garden","expected":{"projects":["garden"],"agents":[],"apps":[]}}' x1
  submit "$s" agent-project '{"name":"finch","project":"garden"}' p1
  submit "$s" agent-project '{"name":"finch","project":"orchard"}' p2
  serve_once "$s"
  local p1; p1=$(fc "$s" status p1)
  assert_eq project_archived "$(field "$p1" code)" "gone project refused"
  assert_eq 'the project "Garden" is archived' "$(field "$p1" reason)" "says which"
  assert_eq True "$(field "$(fc "$s" status p2)" result.unpinned)" "moving in unpins"
  assert_absent "$s/fleet/identities/finch/.pinned" "pin gone"
  grep -qx 'project: orchard' "$s/fleet/identities/finch/finch.md" || fail "filed: $(cat "$s/fleet/identities/finch/finch.md")"
  grep -qx 'task: "Doing finch"' "$s/fleet/identities/finch/finch.md" || fail "other lines kept"
  rm -rf "$s"
}

test_pin_then_move_lands_as_the_last_click_says() {
  local s; s=$(setup)
  project "$s" garden "Garden"; agent "$s" finch garden
  submit "$s" agent-pin '{"name":"finch","pinned":true}' p1
  submit "$s" agent-project '{"name":"finch","project":"garden"}' p2
  serve_once "$s"
  assert_eq garden "$(field "$(fc "$s" status p1)" result.previousProject)" "pin took it out"
  assert_absent "$s/fleet/identities/finch/.pinned" "the later move unpinned"
  grep -qx 'project: garden' "$s/fleet/identities/finch/finch.md" || fail "in the project"
  submit "$s" agent-pin '{"name":"finch","pinned":true}' p3
  serve_once "$s"
  assert_exists "$s/fleet/identities/finch/.pinned" "pinned"
  grep -q '^project:' "$s/fleet/identities/finch/finch.md" && fail "pinned and in a project"
  rm -rf "$s"
}

test_new_agent_into_a_gone_project_lands_in_conversations() {
  local s; s=$(setup)
  project "$s" garden "Garden"; agent "$s" finch garden; agent "$s" wren orchard
  submit "$s" agent-project '{"name":"finch","project":"garden","birth":true}' b1
  submit "$s" agent-project '{"name":"wren","project":"orchard","birth":true}' b2
  serve_once "$s"
  assert_eq garden "$(field "$(fc "$s" status b1)" result.project)" "filed"
  local b2; b2=$(fc "$s" status b2)
  assert_eq done "$(field "$b2" state)" "still made"
  assert_eq "that project is gone" "$(field "$b2" result.notFiled)" "says why"
  grep -q '^project:' "$s/fleet/identities/wren/wren.md" && fail "left pointing at a gone project"
  rm -rf "$s"
}

test_agent_edit_changes_only_its_lines() {
  local s; s=$(setup)
  agent "$s" finch ""
  printf -- '---\nroles: [eng]\ndisplayName: Finch\ntask: "Old"\ncustom: keep\navatar: finch.png\n---\nBody stays.\n' > "$s/fleet/identities/finch/finch.md"
  : > "$s/fleet/identities/finch/finch.png"
  mkdir -p "$s/fleet/.changes/uploads"; printf 'new' > "$s/fleet/.changes/uploads/u1.webp"
  submit "$s" agent-edit '{"name":"finch","set":{"displayName":"Finch Two","task":"Ship: it","colorHue":12,"voice":"alloy"},"avatar":{"upload":"u1.webp","ext":"webp"}}' e1
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status e1)" state)" "edited"
  assert_eq "$(printf -- '---\nroles: [eng]\ndisplayName: Finch Two\ntask: "Ship: it"\ncolorHue: '"'"'12'"'"'\nvoice: alloy\ncustom: keep\navatar: finch.webp\n---\nBody stays.')" \
    "$(cat "$s/fleet/identities/finch/finch.md")" "only those lines"
  assert_eq new "$(cat "$s/fleet/identities/finch/finch.webp")" "picture in place"
  assert_absent "$s/fleet/identities/finch/finch.png" "old picture gone"
  assert_absent "$s/fleet/.changes/uploads/u1.webp" "upload used up"
  submit "$s" agent-edit '{"name":"finch","unset":["avatar","task"]}' e2
  serve_once "$s"
  grep -q '^avatar:\|^task:' "$s/fleet/identities/finch/finch.md" && fail "removed lines still there"
  assert_absent "$s/fleet/identities/finch/finch.webp" "picture removed"
  rm -rf "$s"
}

test_agent_compact_is_accepted_at_its_turn() {
  local s; s=$(setup)
  agent "$s" finch ""; agent "$s" wren ""
  submit "$s" agent-compact '{"name":"finch","guidance":"keep the\nfailing \u001b[201~ test"}' c1
  submit "$s" agent-compact '{"name":"finch"}' c2
  submit "$s" agent-compact '{"name":"wren"}' c3
  submit "$s" agent-archive '{"name":"wren"}' a1
  submit "$s" agent-compact '{"name":"wren"}' c4
  submit "$s" agent-compact '{"name":"nobody"}' c5
  agent "$s" robin ""
  submit "$s" agent-compact "{\"name\":\"robin\",\"guidance\":\"$(printf 'k%.0s' $(seq 701))\"}" c6
  submit "$s" agent-compact "{\"name\":\"robin\",\"guidance\":\"$(printf 'k%.0s' $(seq 700))\"}" c7
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status c1)" state)" "accepted"
  assert_eq "keep the failing [201~ test" "$(cat "$s/fleet/identities/finch/.compact-queued")" "guidance on one line, no control characters"
  assert_eq True "$(field "$(fc "$s" status c2)" result.already)" "a second one while one waits is the same one"
  assert_eq done "$(field "$(fc "$s" status c3)" state)" "before the archive: accepted"
  assert_eq being_archived "$(field "$(fc "$s" status c4)" code)" "after the archive's claim: refused"
  assert_eq not_found "$(field "$(fc "$s" status c5)" code)" "no such agent"
  assert_eq bad_request "$(field "$(fc "$s" status c6)" code)" "guidance too long for the /compact paste: refused"
  fc "$s" status c6 | grep -q "701 bytes; the most is 700" || fail "refusal says how long it was and the limit"
  assert_eq done "$(field "$(fc "$s" status c7)" state)" "guidance at the limit: accepted"
  assert_exists "$s/fleet/identities/.supervisor-wake" "the supervisor is woken for it"
  rm -rf "$s"
}

test_agent_changes_refused_while_its_archive_is_claimed() {
  local s; s=$(setup)
  project "$s" garden "Garden"; agent "$s" finch ""
  mkdir -p "$s/fleet/.changes/uploads"; printf 'x' > "$s/fleet/.changes/uploads/u2.png"
  submit "$s" agent-archive '{"name":"finch"}' a1
  submit "$s" agent-project '{"name":"finch","project":"garden"}' p1
  submit "$s" agent-pin '{"name":"finch","pinned":true}' p2
  submit "$s" agent-edit '{"name":"finch","set":{"task":"x"},"avatar":{"upload":"u2.png","ext":"png"}}' e1
  serve_once "$s"
  for id in p1 p2 e1; do assert_eq being_archived "$(field "$(fc "$s" status $id)" code)" "$id refused"; done
  assert_absent "$s/fleet/.changes/uploads/u2.png" "unused picture removed"
  assert_absent "$s/fleet/identities/finch/u2.png" "never put in its folder"
  assert_absent "$s/fleet/identities/finch/.pinned" "not pinned"
  rm -rf "$s"
}

test_odd_usernames_and_names_stay_strings() {
  local s; s=$(setup)
  project "$s" team "Team"; limited "$s" team 123 true; project "$s" sub "Sub" team
  submit "$s" project-move '{"slug":"sub","parent":null}' m1
  submit "$s" project-create '{"baseSlug":"e","displayName":"1e5"}' c1
  serve_once "$s"
  assert_eq "$(printf -- '---\ndisplayName: Sub\nusers:\n  - "123"\n  - "true"\n---')" "$(cat "$s/fleet/projects/sub/project.md")" "usernames quoted"
  assert_eq 'displayName: "1e5"' "$(sed -n 2p "$s/fleet/projects/e/project.md")" "a number-looking name quoted"
  rm -rf "$s"
}

test_a_file_without_frontmatter_gets_one() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/projects/bare"; printf '# Notes\n' > "$s/fleet/projects/bare/project.md"
  submit "$s" project-rename '{"slug":"bare","displayName":"Bare"}' r1
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status r1)" state)" "renamed"
  assert_eq "$(printf -- '---\ndisplayName: Bare\n---\n# Notes')" "$(cat "$s/fleet/projects/bare/project.md")" "frontmatter added"
  rm -rf "$s"
}

test_move_to_a_hidden_project_answers_like_a_gone_one() {
  local s; s=$(setup)
  project "$s" secret "Secret"; limited "$s" secret ana; agent "$s" finch ""
  mkdir -p "$s/fleet/projects/archive/vault"; printf -- '---\ndisplayName: Vault\nusers:\n  - ana\n---\n' > "$s/fleet/projects/archive/vault/project.md"
  submit "$s" agent-project '{"name":"finch","project":"secret","asker":"bo"}' p1
  submit "$s" agent-project '{"name":"finch","project":"vault","asker":"bo"}' p2
  submit "$s" agent-project '{"name":"finch","project":"vault","asker":"ana"}' p3
  serve_once "$s"
  local p1 p2; p1=$(fc "$s" status p1); p2=$(fc "$s" status p2)
  assert_eq project_not_found "$(field "$p1" code)" "hidden reads as gone"
  assert_eq "that project is gone" "$(field "$p2" reason)" "an archived name stays hidden too"
  assert_eq 'the project "Vault" is archived' "$(field "$(fc "$s" status p3)" reason)" "named to someone who could see it"
  grep -q '^project: [a-z]' "$s/fleet/identities/finch/finch.md" && fail "filed anyway"
  rm -rf "$s"
}

# Who asked is kept with the request; a person's refusal, failure or un-filed new agent is
# kept as a notice for a day; agents' own changes and look-only requests never are.
test_who_asked_and_their_notices() {
  local s; s=$(setup)
  project "$s" garden "Garden"; agent "$s" finch garden; agent "$s" wren garden
  fc "$s" submit agent-project '{"name":"finch","project":"orchard"}' --id m1 --by user:u_Ann-1 --wait 0 >/dev/null
  fc "$s" submit agent-project '{"name":"wren","project":"orchard"}' --id m2 --by agent:wren --wait 0 >/dev/null
  fc "$s" submit agent-project '{"name":"finch","project":"orchard","birth":true}' --id b1 --by user:u_Ann-1 --wait 0 >/dev/null
  fc "$s" submit project-contents '{"slug":"nope"}' --id c1 --by user:u_Ann-1 --wait 0 >/dev/null
  fc "$s" submit agent-archive '{"name":"wren"}' --id a1 --by user:u_Bob --wait 0 >/dev/null
  serve_once "$s"
  local n="$s/fleet/.changes/notices"
  assert_eq refused "$(field "$(cat "$n/m1.json")" state)" "refusal kept"
  assert_eq '{"user": "u_Ann-1"}' "$(field "$(cat "$n/m1.json")" by)" "who asked"
  assert_eq orchard "$(field "$(cat "$n/m1.json")" args.project)" "what was asked"
  assert_absent "$n/m2.json" "an agent's own change has no one to tell"
  assert_eq unfiled "$(field "$(cat "$n/b1.json")" state)" "new agent left out"
  assert_absent "$n/c1.json" "a look-only request is never a notice"
  assert_absent "$n/a1.json" "a done change is no notice"
  assert_eq '{"user": "u_Bob"}' "$(field "$(cat "$s/fleet/identities/wren/.archiving")" asked_by)" "claim says who"
  assert_eq '{"user": "u_Ann-1"}' "$(field "$(fc "$s" status m1)" by)" "outcome says who"
  local rc=0; fc "$s" submit agent-pin '{"name":"finch","pinned":true}' --by "user:a b" --wait 0 >/dev/null 2>&1 || rc=$?
  assert_eq 2 "$rc" "a malformed asker is a usage error"
  touch -d '25 hours ago' "$n/m1.json"
  FLEET_CHANGE_FLEET_DIR="$s/fleet" python3 -c '
import importlib.machinery, sys
m = importlib.machinery.SourceFileLoader("fc", sys.argv[1]).load_module(); m.prune()' "$FC"
  assert_absent "$n/m1.json" "gone after a day"
  assert_exists "$n/b1.json" "a fresh one stays"
  rm -rf "$s"
}

test_role_edit_changes_only_its_lines() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/roles/eng"
  printf -- '---\ndisplayName: Engineer\ndescription: >-\n  Old words\n  over two lines\ncustom: keep\n---\nAn agent wrote this.\n' > "$s/fleet/roles/eng/eng.md"
  submit "$s" role-edit '{"name":"eng","set":{"description":"Builds: things","colorHue":40,"borrowable":true}}' r1
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status r1)" state)" "edited"
  assert_eq "$(printf -- '---\ndisplayName: Engineer\ndescription: "Builds: things"\ncolorHue: '"'"'40'"'"'\nborrowable: true\ncustom: keep\n---\nAn agent wrote this.')" \
    "$(cat "$s/fleet/roles/eng/eng.md")" "only those lines; the body an agent wrote stays"
  submit "$s" role-edit '{"name":"eng","unset":["borrowable","description"]}' r2
  serve_once "$s"
  grep -q '^borrowable:\|^description:' "$s/fleet/roles/eng/eng.md" && fail "removed lines still there"
  submit "$s" role-edit '{"name":"eng","unset":["displayName"]}' r3
  serve_once "$s"
  assert_eq bad_request "$(field "$(fc "$s" status r3)" code)" "the name can't be removed"
  printf '{"id":"x"}' > "$s/fleet/roles/eng/.archiving"
  submit "$s" role-edit '{"name":"eng","set":{"colorHue":1}}' r4
  serve_once "$s"
  assert_eq being_archived "$(field "$(fc "$s" status r4)" code)" "refused while being archived"
  rm -rf "$s"
}

stage() { mkdir -p "$1/fleet/.changes/uploads"; printf '%s' "$3" > "$1/fleet/.changes/uploads/$2"; }
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

test_file_save_only_over_what_the_editor_opened() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/identities/finch/workspace"
  local f="$s/fleet/identities/finch/workspace/notes.md"
  printf 'v1' > "$f"; chmod 600 "$f"
  stage "$s" save-a 'mine'
  submit "$s" file-save "{\"path\":\"fleet/identities/finch/workspace/notes.md\",\"upload\":\"save-a\",\"expect\":\"$(sha v1)\"}" w1
  serve_once "$s"
  local out; out=$(fc "$s" status w1)
  assert_eq done "$(field "$out" state)" "saved over the version it opened"
  assert_eq mine "$(cat "$f")" "written"
  assert_eq "$(sha mine)" "$(field "$out" result.version)" "answers with the new version"
  assert_eq 600 "$(stat -c %a "$f")" "keeps the file's permissions"
  assert_absent "$s/fleet/.changes/uploads/save-a" "staged file used up"
  # An agent wrote in the meantime: the stale save is refused, and says what's there now.
  printf 'agent' > "$f"
  stage "$s" save-b 'stale'
  submit "$s" file-save "{\"path\":\"fleet/identities/finch/workspace/notes.md\",\"upload\":\"save-b\",\"expect\":\"$(sha mine)\"}" w2
  serve_once "$s"
  out=$(fc "$s" status w2)
  assert_eq changed "$(field "$out" code)" "refused"
  assert_eq "$(sha agent)" "$(field "$out" result.version)" "current version given"
  assert_eq agent "$(cat "$f")" "the agent's words stay"
  assert_absent "$s/fleet/.changes/uploads/save-b" "refused save's staged file dropped"
  # Saving again with that version overwrites on purpose.
  stage "$s" save-c 'stale'
  submit "$s" file-save "{\"path\":\"fleet/identities/finch/workspace/notes.md\",\"upload\":\"save-c\",\"expect\":\"$(sha agent)\"}" w3
  serve_once "$s"
  assert_eq stale "$(cat "$f")" "overwritten on purpose"
  # A new file: "absent" only while there's none.
  stage "$s" save-d 'new'
  submit "$s" file-save '{"path":"fleet/identities/finch/workspace/new.txt","upload":"save-d","expect":"absent"}' w4
  stage "$s" save-e 'other'
  submit "$s" file-save '{"path":"fleet/identities/finch/workspace/new.txt","upload":"save-e","expect":"absent"}' w5
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status w4)" state)" "new file made"
  out=$(fc "$s" status w5)
  assert_eq exists "$(field "$out" code)" "second one finds it there"
  assert_eq "$(sha new)" "$(field "$out" result.version)" "and its version"
  # Deleted since it was opened.
  rm "$f"
  stage "$s" save-f 'x'
  submit "$s" file-save "{\"path\":\"fleet/identities/finch/workspace/notes.md\",\"upload\":\"save-f\",\"expect\":\"$(sha stale)\"}" w6
  serve_once "$s"
  out=$(fc "$s" status w6)
  assert_eq changed "$(field "$out" code)" "gone counts as changed"
  assert_eq None "$(field "$out" result.version)" "no version: there's no file"
  assert_absent "$f" "not recreated"
  rm -rf "$s"
}

test_file_save_stays_inside_the_home_folder() {
  local s outside; s=$(setup); outside=$(mktemp -d)
  ln -s "$outside" "$s/fleet/out"
  for p in '../x' '/etc/x' 'fleet/../../x' 'fleet/out/x' 'fleet//x'; do
    stage "$s" save-p 'x'
    submit "$s" file-save "{\"path\":\"$p\",\"upload\":\"save-p\",\"expect\":\"absent\"}" "p$RANDOM"
  done
  serve_once "$s"
  local n; n=$(for f in "$s"/fleet/.changes/outcomes/*.json; do field "$(cat "$f")" code; done | grep -c bad_request)
  assert_eq 5 "$n" "every path outside the home folder refused"
  assert_absent "$outside/x" "nothing written through the link"
  rm -rf "$s" "$outside"
}

test_project_file_save_keeps_the_machines_member_list() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/projects/garden"
  local f="$s/fleet/projects/garden/project.md"
  local opened; opened=$(printf -- '---\ndisplayName: Garden\nmembers:\n  - finch\n---\nOld notes.\n')
  printf '%s\n' "$opened" > "$f"
  local v; v=$(python3 -c 'import hashlib,re,sys
t=open(sys.argv[1]).read(); t=re.sub(r"members:\n(  - .*\n)*", "", t, count=1); print(hashlib.sha256(t.encode()).hexdigest())' "$f")
  # Agents joined since the editor opened it: not a change.
  printf -- '---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nOld notes.\n' > "$f"
  stage "$s" save-m "$(printf -- '---\ndisplayName: Garden\nmembers:\n  - finch\n---\nNew notes.\n')"
  submit "$s" file-save "{\"path\":\"fleet/projects/garden/project.md\",\"upload\":\"save-m\",\"expect\":\"$v\",\"keepMembers\":true}" m1
  serve_once "$s"
  assert_eq done "$(field "$(fc "$s" status m1)" state)" "member list changing isn't a change"
  assert_eq "$(printf -- '---\ndisplayName: Garden\nmembers:\n  - finch\n  - wren\n---\nNew notes.')" "$(cat "$f")" "the machine's member list stays"
  # Moved by someone else since: refused.
  printf -- '---\ndisplayName: Garden\nparent: farm\nmembers:\n  - finch\n  - wren\n---\nNew notes.\n' > "$f"
  stage "$s" save-n "$(printf -- '---\ndisplayName: Garden\n---\nStale.\n')"
  local v2; v2=$(field "$(fc "$s" status m1)" result.version)
  submit "$s" file-save "{\"path\":\"fleet/projects/garden/project.md\",\"upload\":\"save-n\",\"expect\":\"$v2\",\"keepMembers\":true}" m2
  serve_once "$s"
  assert_eq changed "$(field "$(fc "$s" status m2)" code)" "a parent change counts"
  grep -q '^parent: farm' "$f" || fail "the move stays"
  rm -rf "$s"
}

test_file_save_checks_at_its_turn_what_a_move_would() {
  local s; s=$(setup)
  project "$s" x "X"; project "$s" y "Y"
  local f="$s/fleet/projects/x/project.md"
  local v; v=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$f")
  # Y was moved inside X after the editor's save was checked by the server, before its turn.
  project "$s" y "Y" x
  stage "$s" save-l "$(printf -- '---\ndisplayName: X\nparent: y\n---\n')"
  submit "$s" file-save "{\"path\":\"fleet/projects/x/project.md\",\"upload\":\"save-l\",\"expect\":\"$v\",\"keepMembers\":true,\"project\":{\"slug\":\"x\"}}" l1
  serve_once "$s"
  assert_eq into_itself "$(field "$(fc "$s" status l1)" code)" "a loop is refused at its turn"
  grep -q '^parent:' "$f" && fail "x was moved"
  rm -rf "$s"
}

test_file_save_leaves_the_machines_own_files_and_claimed_folders_alone() {
  local s; s=$(setup)
  agent "$s" finch ""; mkdir -p "$s/fleet/apps/tally"
  for p in fleet/apps/tally/.move-requested fleet/.changes/incoming/x.json fleet/identities/finch/.archiving; do
    stage "$s" save-k 'x'
    submit "$s" file-save "{\"path\":\"$p\",\"upload\":\"save-k\",\"expect\":\"absent\"}" "k$RANDOM"
  done
  serve_once "$s"
  local n; n=$(for f in "$s"/fleet/.changes/outcomes/*.json; do field "$(cat "$f")" code; done | grep -c machine_file)
  assert_eq 3 "$n" "the machine's own files refused"
  printf '{"id":"x"}' > "$s/fleet/identities/finch/.archiving"
  local v; v=$(sha256sum < "$s/fleet/identities/finch/finch.md" | cut -d' ' -f1)
  stage "$s" save-c 'mine'
  submit "$s" file-save "{\"path\":\"fleet/identities/finch/finch.md\",\"upload\":\"save-c\",\"expect\":\"$v\"}" c1
  serve_once "$s"
  assert_eq being_archived "$(field "$(fc "$s" status c1)" code)" "not into a folder being archived"
  rm -rf "$s"
}

test_line_edits_keep_windows_line_ends() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/roles/eng"
  printf -- '---\r\ndisplayName: Eng\r\n---\r\nBody\r\n' > "$s/fleet/roles/eng/eng.md"
  submit "$s" role-edit '{"name":"eng","set":{"colorHue":5}}' e1
  serve_once "$s"
  assert_eq "$(printf -- '---\r\ndisplayName: Eng\r\ncolorHue: '"'"'5'"'"'\r\n---\r\nBody\r\n' | od -c)" "$(od -c < "$s/fleet/roles/eng/eng.md")" "only the new line; the rest byte for byte"
  rm -rf "$s"
}

test_waiting_saves_keep_their_staged_copy() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/identities/finch/workspace"
  stage "$s" save-w 'kept'; stage "$s" save-old 'stray'
  touch -d '2 hours ago' "$s/fleet/.changes/uploads/save-w" "$s/fleet/.changes/uploads/save-old"
  submit "$s" file-save '{"path":"fleet/identities/finch/workspace/w.txt","upload":"save-w","expect":"absent"}' w1
  FLEET_CHANGE_FLEET_DIR="$s/fleet" python3 -c 'import importlib.machinery as m, importlib.util as u, sys
l = m.SourceFileLoader("fc", sys.argv[1]); fc = u.module_from_spec(u.spec_from_loader("fc", l)); l.exec_module(fc); fc.take_in(); fc.prune()' "$FC"
  assert_exists "$s/fleet/.changes/uploads/save-w" "a save still waiting keeps its copy"
  assert_absent "$s/fleet/.changes/uploads/save-old" "a stray one goes"
  serve_once "$s"
  assert_eq kept "$(cat "$s/fleet/identities/finch/workspace/w.txt")" "and lands"
  rm -rf "$s"
}

test_a_save_cut_off_after_writing_is_reported_saved() {
  local s; s=$(setup)
  mkdir -p "$s/fleet/identities/finch/workspace" "$s/fleet/.changes/journal"
  printf 'written' > "$s/fleet/identities/finch/workspace/n.txt"
  local v; v=$(printf 'written' | sha256sum | cut -d' ' -f1)
  # The listener stopped after the file went in, before its outcome was written.
  printf '{"seq":4,"id":"f1","kind":"file-save","args":{"path":"fleet/identities/finch/workspace/n.txt","upload":"save-f1","expect":"absent"},"state":"running","plan":{"writing":"%s"}}' "$v" \
    > "$s/fleet/.changes/journal/0000000004-f1.json"
  serve_once "$s"
  local a; a=$(fc "$s" status f1)
  assert_eq done "$(field "$a" state)" "saved, not 'didn't arrive'"
  assert_eq "$v" "$(field "$a" result.version)" "with its version"
  rm -rf "$s"
}

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
run_test test_group_archives_refused_when_an_agents_slot_is_taken
run_test test_sleep_sweep_refused_when_the_agent_woke
run_test test_app_unarchive_start_is_tried_again
run_test test_project_create_skips_names_with_leftovers
run_test test_project_create_inside_a_limited_project_shares_it
run_test test_project_rename_changes_only_its_name
run_test test_project_move_checks_at_its_turn
run_test test_project_move_never_widens_its_audience
run_test test_agent_move_to_a_gone_project_is_refused
run_test test_pin_then_move_lands_as_the_last_click_says
run_test test_new_agent_into_a_gone_project_lands_in_conversations
run_test test_agent_edit_changes_only_its_lines
run_test test_agent_changes_refused_while_its_archive_is_claimed
run_test test_agent_compact_is_accepted_at_its_turn
run_test test_odd_usernames_and_names_stay_strings
run_test test_a_file_without_frontmatter_gets_one
run_test test_move_to_a_hidden_project_answers_like_a_gone_one
run_test test_who_asked_and_their_notices
run_test test_project_archive_tells_the_people_whose_agents_it_took
run_test test_role_edit_changes_only_its_lines
run_test test_file_save_only_over_what_the_editor_opened
run_test test_file_save_stays_inside_the_home_folder
run_test test_project_file_save_keeps_the_machines_member_list
run_test test_file_save_checks_at_its_turn_what_a_move_would
run_test test_file_save_leaves_the_machines_own_files_and_claimed_folders_alone
run_test test_line_edits_keep_windows_line_ends
run_test test_waiting_saves_keep_their_staged_copy
run_test test_a_save_cut_off_after_writing_is_reported_saved

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
