#!/usr/bin/env bash
# shellcheck shell=bash
#
# Test driver for the sweep's `changes` line (fleet-status-sweep.py, source F): the
# machine's open changes as its front door (fleet-change) keeps them on disk —
#   - changes waiting their turn, with what they're about, where a move goes, who asked
#     and who can see the thing (audience) and its destination (to_audience)
#   - people's refusals, failures and un-filed new agents (notices), never agents' own
#   - archives stuck for 10 minutes, with who to tell
#   - agents on their way back from the archive, with what their row shows
#
# The state is made by fleet-change itself, so the two agree on the layout.
#
# Usage: bash substrate/scripts/tests/fleet-status-sweep-changes.test.sh   (from repo root)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SWEEP="$REPO_ROOT/substrate/scripts/fleet-status-sweep.py"
FC="$REPO_ROOT/substrate/scripts/fleet-change"

PASS=0
FAIL=0
FAILURES=()
CURRENT_TEST=""

fail() { FAILURES+=("${CURRENT_TEST:-unknown}: ${1:-unknown failure}"); FAIL=$((FAIL + 1)); }
assert_eq() { [ "$1" = "$2" ] || fail "${3:-assert_eq}: expected='$1' got='$2'"; }

run_test() {
  local fn="$1" before=$FAIL
  CURRENT_TEST="$fn"
  "$fn"
  if [ "$FAIL" -eq "$before" ]; then PASS=$((PASS + 1)); printf '  OK   %s\n' "$fn"; else printf '  FAIL %s\n' "$fn"; fi
  CURRENT_TEST=""
}

setup() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/fleet/identities" "$h/fleet/projects" "$h/fleet/roles"
  printf '%s' "$h"
}
fc() { local h="$1"; shift; FLEET_CHANGE_FLEET_DIR="$h/fleet" FLEET_CHANGE_POLL_S=0.02 python3 "$FC" "$@"; }
serve_once() { fc "$1" serve --until-idle >/dev/null 2>&1; }
agent() {  # agent <h> <name> <project> [users]
  mkdir -p "$1/fleet/identities/$2"
  { printf -- '---\nroles: []\nproject: %s\n' "$3"; [ -n "${4:-}" ] && printf 'users: [%s]\n' "$4"; printf -- '---\n'; } \
    > "$1/fleet/identities/$2/$2.md"
}
project() {  # project <h> <slug> [users]
  mkdir -p "$1/fleet/projects/$2"
  { printf -- '---\ndisplayName: %s\n' "$2"; [ -n "${3:-}" ] && printf 'users: [%s]\n' "$3"; printf -- '---\n'; } \
    > "$1/fleet/projects/$2/project.md"
}
# The changes line, or "" when there is none.
changes() { HOME="$1" python3 "$SWEEP" 2>/dev/null | python3 -c '
import json, sys
for l in sys.stdin:
    d = json.loads(l)
    if d.get("line_kind") == "changes":
        print(json.dumps(d, sort_keys=True))'; }
# q <json> <python expression over d> — print the expression's value.
q() { python3 -c 'import json, sys; d = json.loads(sys.argv[1]); v = eval(sys.argv[2])
print(v if isinstance(v, str) else json.dumps(v, sort_keys=True))' "$1" "$2"; }

test_no_front_door_no_line() {
  local h; h=$(setup)
  assert_eq "" "$(changes "$h")" "no line without ~/fleet/.changes"
  rm -rf "$h"
}

test_waiting_move_says_where_and_for_whom() {
  local h; h=$(setup)
  project "$h" garden "ann, bob"; agent "$h" finch "" "ann"
  fc "$h" submit agent-project '{"name":"finch","project":"garden"}' --id m1 --by user:u1 --wait 0 >/dev/null
  local c; c=$(changes "$h")
  assert_eq 1 "$(q "$c" 'len(d["changes"])')" "one entry"
  local e; e=$(q "$c" 'd["changes"][0]')
  assert_eq waiting "$(q "$e" 'd["state"]')" "waiting"
  assert_eq '{"name": "finch", "type": "agent"}' "$(q "$e" 'd["target"]')" "about finch"
  assert_eq '{"project": "garden"}' "$(q "$e" 'd["to"]')" "going to garden"
  assert_eq '["ann"]' "$(q "$e" 'd["audience"]')" "who can see finch"
  assert_eq '["ann", "bob"]' "$(q "$e" 'd["to_audience"]')" "who can see garden"
  assert_eq u1 "$(q "$e" 'd["by_user"]')" "who asked"
  rm -rf "$h"
}

test_notices_and_what_is_still_open() {
  local h; h=$(setup)
  agent "$h" finch ""; agent "$h" wren ""
  fc "$h" submit agent-pin '{"name":"finch","pinned":true}' --id p1 --by user:u1 --wait 0 >/dev/null
  fc "$h" submit agent-project '{"name":"finch","project":"gone"}' --id m1 --by user:u1 --wait 0 >/dev/null
  fc "$h" submit agent-project '{"name":"wren","project":"gone"}' --id m2 --by agent:wren --wait 0 >/dev/null
  serve_once "$h"
  fc "$h" submit agent-pin '{"name":"wren","pinned":true}' --id p2 --wait 0 >/dev/null
  serve_once "$h"
  fc "$h" submit agent-pin '{"name":"wren","pinned":false}' --id p3 --wait 0 >/dev/null
  local c; c=$(changes "$h")
  assert_eq '["m1:refused", "p3:waiting"]' "$(q "$c" 'sorted(e["id"] + ":" + e["state"] for e in d["changes"])')" \
    "the person's refusal and the waiting pin; never the agent's own refusal"
  assert_eq "that project is gone" "$(q "$c" '[e for e in d["changes"] if e["id"] == "m1"][0]["reason"]')" "why"
  rm -rf "$h"
}

test_taken_notice_is_for_the_agents_people() {
  local h; h=$(setup)
  project "$h" shared "ann, bob"; agent "$h" bea shared "bob"
  fc "$h" submit project-archive '{"slug":"shared","asker":"ann","expected":{"projects":["shared"],"agents":["bea"],"apps":[]}}' --id a1 --by user:u_ann --wait 0 >/dev/null
  serve_once "$h"
  local c; c=$(changes "$h")
  local e; e=$(q "$c" '[e for e in d["changes"] if e["state"] == "taken"][0]')
  assert_eq '{"name": "bea", "type": "agent"}' "$(q "$e" 'd["target"]')" "about bea"
  assert_eq '["bob"]' "$(q "$e" 'd["audience"]')" "for bob, not ann"
  assert_eq 'it was archived with the project "shared" by ann' "$(q "$e" 'd["reason"]')" "which project, and who"
  rm -rf "$h"
}

test_stuck_archive_names_who_to_tell() {
  local h; h=$(setup)
  agent "$h" finch ""
  fc "$h" submit agent-archive '{"name":"finch"}' --id a1 --by user:u9 --wait 0 >/dev/null
  serve_once "$h"
  assert_eq '[]' "$(q "$(changes "$h")" 'd["changes"]')" "claimed and fine: nothing to show"
  python3 - "$h/fleet/identities/finch/.archiving" <<'PY'
import json, sys, time
p = sys.argv[1]; c = json.load(open(p))
c.update(failing_since=time.time() - 700, last_error="couldn't switch the chat account off")
json.dump(c, open(p, "w"))
PY
  local e; e=$(q "$(changes "$h")" 'd["changes"][0]')
  assert_eq "stuck a1 u9" "$(q "$e" 'd["state"] + " " + d["id"] + " " + d["by_user"]')" "stuck, for whoever archived it"
  assert_eq "couldn't switch the chat account off" "$(q "$e" 'd["reason"]')" "why"
  rm -rf "$h"
}

test_agent_coming_back_carries_its_row() {
  local h; h=$(setup)
  mkdir -p "$h/fleet/identities-archive/wren"
  printf -- '---\nroles: []\ndisplayName: Wren\nproject: garden\nusers: [ann]\n---\n' > "$h/fleet/identities-archive/wren/wren.md"
  fc "$h" submit agent-unarchive '{"name":"wren"}' --id u1 --by user:u7 --wait 0 >/dev/null
  serve_once "$h"
  local c; c=$(changes "$h")
  assert_eq 1 "$(q "$c" 'len(d["changes"])')" "one entry"
  local e; e=$(q "$c" 'd["changes"][0]')
  assert_eq "returning u1 u7" "$(q "$e" 'd["state"] + " " + d["id"] + " " + d["by_user"]')" "coming back"
  assert_eq '{"display_name": "Wren", "project": "garden"}' "$(q "$e" 'd["card"]')" "its row"
  assert_eq '["ann"]' "$(q "$e" 'd["audience"]')" "read from the archived file"
  rm -rf "$h"
}

test_role_archive_marks_its_agents() {
  local h; h=$(setup)
  mkdir -p "$h/fleet/roles/eng"; printf -- '---\ndisplayName: Eng\n---\n' > "$h/fleet/roles/eng/eng.md"
  agent "$h" ann ""
  fc "$h" submit role-archive '{"name":"eng","expected":{"agents":["ann"]}}' --id r1 --wait 0 >/dev/null
  assert_eq '["agent:ann", "role:eng"]' "$(q "$(changes "$h")" 'sorted(e["target"]["type"] + ":" + e["target"]["name"] for e in d["changes"])')" \
    "the role and the agent it takes"
  rm -rf "$h"
}

test_nothing_named_to_people_who_cant_see_it() {
  local h; h=$(setup)
  project "$h" secret "ann"
  fc "$h" submit project-create '{"baseSlug":"plans","displayName":"Plans","asker":"bob","multiUser":true}' --id c1 --by user:u2 --wait 0 >/dev/null
  fc "$h" submit project-create '{"baseSlug":"inner","displayName":"Inner","parent":"secret"}' --id c2 --wait 0 >/dev/null
  mkdir -p "$h/fleet/roles-archive/ops"; printf -- '---\nusers: [ann]\n---\n' > "$h/fleet/roles-archive/ops/ops.md"
  fc "$h" submit role-unarchive '{"name":"ops"}' --id r1 --wait 0 >/dev/null
  mkdir -p "$h/fleet/apps-archive/beds"; printf '{"title":"Beds","users":["ann"]}' > "$h/fleet/apps-archive/beds/app.json"
  fc "$h" submit app-unarchive '{"slug":"beds"}' --id a1 --wait 0 >/dev/null
  mkdir -p "$h/fleet/identities-archive/wren"
  printf -- '---\nroles: []\nproject: secret\n---\n' > "$h/fleet/identities-archive/wren/wren.md"
  mkdir -p "$h/fleet/.changes/returning"; printf '{"name":"wren","ids":["u1"],"accepted_at":1}' > "$h/fleet/.changes/returning/wren.json"
  local c; c=$(changes "$h")
  local of='lambda i, k: [e for e in d["changes"] if e["id"] == i][0].get(k)'
  assert_eq '["bob"]' "$(q "$c" "($of)('c1', 'audience')")" "a new project: only whoever asked"
  assert_eq '["ann"]' "$(q "$c" "($of)('c2', 'audience')")" "a new sub-project: whoever sees its parent"
  assert_eq '["ann"]' "$(q "$c" "($of)('r1', 'audience')")" "an archived role, read in the archive"
  assert_eq '["ann"]' "$(q "$c" "($of)('a1', 'audience')")" "an archived app, read in the archive"
  assert_eq '["ann"]' "$(q "$c" "($of)('u1', 'card_audience')")" "where it lands, gated"
  rm -rf "$h"
}

run_test test_no_front_door_no_line
run_test test_waiting_move_says_where_and_for_whom
run_test test_notices_and_what_is_still_open
run_test test_taken_notice_is_for_the_agents_people
run_test test_stuck_archive_names_who_to_tell
run_test test_agent_coming_back_carries_its_row
run_test test_role_archive_marks_its_agents
run_test test_nothing_named_to_people_who_cant_see_it

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failures:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
