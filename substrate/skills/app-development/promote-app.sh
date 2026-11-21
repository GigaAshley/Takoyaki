#!/usr/bin/env bash
# promote-app.sh <slug> --users a,b | --everyone — move an app to the sidebar.
# Kept for agents that learned this name; move-app.sh does the work (see it
# for the details, including why it must say who may see the app).
set -euo pipefail
[ $# -ge 1 ] || { printf '[promote-app] ERROR: usage: promote-app.sh <slug> --users a,b,... | --everyone\n' >&2; exit 1; }
slug="$1"; shift
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/move-app.sh" "$slug" sidebar "$@"
