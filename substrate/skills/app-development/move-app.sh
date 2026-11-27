#!/usr/bin/env bash
# move-app.sh — move an app between scopes: the sidebar, a project, or out of
# a conversation.
#
#   move-app.sh <slug> sidebar --users a,b,...     becomes a sidebar app in ~/fleet/apps/<slug>/,
#   move-app.sh <slug> sidebar --everyone          shared with those people / with everyone
#   move-app.sh <slug> project <project>           becomes a project app in
#                                                  ~/fleet/projects/<project>/apps/<slug>/
#
# Nothing moves INTO a conversation. Run by the machine's front door
# (fleet-change app-move), in turn with the machine's other changes. Run any
# other way (an agent typing it), it hands the move to the front door and
# prints the outcome: the same as `fleet-change submit app-move …`.
#
# A move to the sidebar must say who may see the app there: --users with the
# people who could see it where it was (so it never shows to anyone new), or
# --everyone when everyone on the machine could already see it (no list). A
# project app never has a list of its own (whoever sees the project sees it),
# so a move into a project drops any list.
#
# Steps: stop and remove the app's units, move the folder (code, data, icon,
# .may-sleep and all), write the list into app.json, reinstall the units on
# the SAME port so the app's address is unchanged (chips and open panes keep
# working), then knock on the port. Any failure after the units are removed
# puts the folder, its app.json and its units back where they were.

set -euo pipefail

log() { printf '[move-app] %s\n' "$*"; }
die() { printf '[move-app] ERROR: %s\n' "$*" >&2; exit 1; }

usage() { die "usage: move-app.sh <slug> sidebar --users a,b,... | move-app.sh <slug> sidebar --everyone | move-app.sh <slug> project <project>"; }

[ $# -ge 2 ] || usage
SLUG="$1"; DEST_KIND="$2"; shift 2
[[ "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid slug: '$SLUG'"

FLEET="${APP_UNITS_FLEET_DIR:-$HOME/fleet}"
UNITS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/app-units.sh"
USERS=""
HAS_USERS=0
PROJECT=""

case "$DEST_KIND" in
    sidebar)
        if [ "${1:-}" = "--users" ] && [ $# -eq 2 ]; then
            USERS="$2"; HAS_USERS=1
            [[ "$USERS" =~ ^[^,[:space:]]+(,[^,[:space:]]+)*$ ]] || die "--users must be a comma-separated list of usernames"
        elif [ "${1:-}" = "--everyone" ] && [ $# -eq 1 ]; then
            :
        else
            die "say who may see it in the sidebar: --users a,b,... (the people who could see it where it is) or --everyone"
        fi
        DEST="$FLEET/apps/$SLUG"
        [ -d "$FLEET/apps" ] || die "$FLEET/apps does not exist — run bootstrap.sh first"
        ;;
    project)
        [ $# -eq 1 ] || usage
        PROJECT="$1"
        [[ "$PROJECT" =~ ^[a-z0-9-]{1,64}$ ]] && [ "$PROJECT" != archive ] || die "invalid project: '$PROJECT'"
        [ -f "$FLEET/projects/$PROJECT/project.md" ] || die "no project '$PROJECT' on this box"
        DEST="$FLEET/projects/$PROJECT/apps/$SLUG"
        ;;
    *) usage ;;
esac

# Not run by the front door: hand the move to it, so it takes its turn with the
# machine's other changes, and print its outcome (one JSON line).
if [ -z "${FLEET_CHANGE_RUNNING:-}" ]; then
    FC="$(command -v fleet-change 2>/dev/null || true)"
    [ -n "$FC" ] || FC="$HOME/.local/bin/fleet-change"
    [ -f "$FC" ] || die "the machine's front door (fleet-change) isn't installed yet — try again in a few minutes"
    REQ=$(python3 -c 'import json, sys
slug, kind, users, has_users, project = sys.argv[1:6]
out = {"slug": slug, "to": kind}
if kind == "sidebar":
    out["users"] = users.split(",") if has_users == "1" else None
else:
    out["project"] = project
print(json.dumps(out, separators=(",", ":")))' "$SLUG" "$DEST_KIND" "$USERS" "$HAS_USERS" "$PROJECT")
    OUT=$(python3 "$FC" submit app-move "$REQ" --wait 120 ${FLEET_IDENTITY:+--by "agent:$FLEET_IDENTITY"})
    printf '%s\n' "$OUT"
    case "$OUT" in *'"state":"done"'*) exit 0 ;; *) exit 1 ;; esac
fi

# Hold the create lock for the whole move — from finding the app until its
# units are back (and through any rollback) — so a concurrent create-app.sh
# can't claim the port while nothing reserves it, and two moves of the same
# app can't interleave. Released when this script exits.
exec 200>"$FLEET/.create-lock"
flock -x -w 60 200 || die "could not get $FLEET/.create-lock within 60s — another app is being created or moved; try again"

SRC=$(bash "$UNITS" find "$SLUG") || die "no app named '$SLUG' on this box"
[ "$SRC" != "$DEST" ] || die "'$SLUG' is already there ($SRC)"
[ ! -e "$DEST" ] || die "$DEST already exists — refusing to overwrite"
[ -f "$SRC/app.json" ] || die "$SRC/app.json is missing — publish the app before moving it"

PORT=$(bash "$UNITS" port "$SLUG") || die "could not read app-$SLUG's port from its units"
log "moving $SLUG (port $PORT): $SRC -> $DEST"

# app.json is rewritten in the new place; keep the original to put back.
ORIG_META=$(mktemp)
cp "$SRC/app.json" "$ORIG_META"

ROLLBACK=0
rollback() {
    if [ "$ROLLBACK" = 1 ]; then
        log "rolling back — putting $SLUG back in $SRC"
        bash "$UNITS" uninstall "$SLUG" 2>/dev/null || true
        if [ -d "$DEST" ] && [ ! -e "$SRC" ]; then
            mv "$DEST" "$SRC"
            cp "$ORIG_META" "$SRC/app.json" || true
        fi
        bash "$UNITS" install "$SLUG" "$SRC" "$PORT" || log "WARNING: reinstall at $SRC failed — check: journalctl --user -u app-$SLUG"
    fi
    rm -f "$ORIG_META"
}
trap rollback EXIT

bash "$UNITS" uninstall "$SLUG"
ROLLBACK=1

mkdir -p "$(dirname "$DEST")"
mv "$SRC" "$DEST"
log "moved folder"

python3 - "$DEST/app.json" "$HAS_USERS" "$USERS" <<'PYEOF'
import json, os, sys, pathlib
p = pathlib.Path(sys.argv[1])
card = json.loads(p.read_text())
card.pop("users", None)
if sys.argv[2] == "1":
    card["users"] = [u for u in sys.argv[3].split(",") if u]
tmp = p.with_name(p.name + ".tmp")
tmp.write_text(json.dumps(card, indent=2) + "\n")
os.replace(tmp, p)
PYEOF

bash "$UNITS" install "$SLUG" "$DEST" "$PORT"

# Any HTTP answer counts — an app whose root page is a 404 or a 500 is still
# running at its new location; only no answer at all means the move broke it.
if [ "${MOVE_APP_KNOCK:-1}" = 1 ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "http://127.0.0.1:$PORT/" || true)
    if [ -z "$CODE" ] || [ "$CODE" = "000" ]; then
        die "app-$SLUG did not answer on 127.0.0.1:$PORT after the move"
    fi
fi

ROLLBACK=0
log "done — $SLUG is now at $DEST (same port $PORT)."
