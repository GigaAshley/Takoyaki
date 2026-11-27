#!/usr/bin/env bash
# shellcheck shell=bash
#
# Hermetic tests for the agent-services host helpers:
#   substrate/scripts/fleet-service   (shared client)
#   and each service's own wrapper, in
#   src/backend/agent-services/services/<name>/bin/
#
# A fake backend (fixtures/fake-service-backend.py) plays the server's part
# over HTTP on a local port: it records what it got (the request JSON,
# attachments, every call and its credential) and answers from a list of
# steps each test gives it.
#
# Every helper runs with HOME=$FIXTURE, so the real ~/fleet is never touched.
#
# Usage: bash substrate/scripts/tests/agent-services.test.sh   (from repo root)
# Requires: bash, coreutils, jq, curl, python3.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICES="$(cd "$SCRIPTS/../../src/backend/agent-services/services" && pwd)"
FLEET_SERVICE="$SCRIPTS/fleet-service"
FAKE_BACKEND="$SCRIPT_DIR/fixtures/fake-service-backend.py"
AGENT_PHONE="$SERVICES/agent-phone/bin/agent-phone"
IMAGE_GEN="$SERVICES/image-gen/bin/image-gen"
STT="$SERVICES/stt/bin/stt"
# On a host the wrappers sit next to fleet-service in ~/.local/bin; here they
# don't, so they find it on PATH.
export PATH="$SCRIPTS:$PATH"

for s in "$FLEET_SERVICE" "$AGENT_PHONE" "$IMAGE_GEN" "$STT"; do
  [ -x "$s" ] || { printf 'FATAL: %s missing or not executable\n' "$s" >&2; exit 1; }
done

FIXTURE=$(mktemp -d)
FAKE="$FIXTURE.fake"
FAKE_PID=""
stop_backend() {
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null && wait "$FAKE_PID" 2>/dev/null
  FAKE_PID=""
}
trap 'stop_backend; rm -rf "$FIXTURE" "$FAKE"' EXIT
CREDENTIAL="tsc_testcredential"

PASS=0
FAIL=0
FAILURES=()
CURRENT_TEST=""

fail() {
  FAILURES+=("$CURRENT_TEST: $1")
  FAIL=$((FAIL + 1))
}

assert_eq() {
  [ "$1" = "$2" ] || fail "${3:-assert_eq}: expected='$1' got='$2'"
}

run_test() {
  local before=$FAIL
  CURRENT_TEST="$1"
  stop_backend
  rm -rf "${FIXTURE:?}"/* "${FAKE:?}"
  mkdir -p "$FIXTURE/fleet/host" "$FAKE"
  printf '%s\n' "$CREDENTIAL" > "$FIXTURE/fleet/host/service-credential"
  "$1"
  stop_backend
  if [ "$FAIL" -eq "$before" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n' "$1"
  fi
}

# fake_backend <steps-json>
# Starts the fake backend answering from the steps (see the fixture), and
# points this machine's address at it.
fake_backend() {
  printf '%s' "$1" > "$FAKE/steps.json"
  python3 "$FAKE_BACKEND" "$FAKE" "$FAKE/steps.json" &
  FAKE_PID=$!
  local i
  for i in $(seq 1 100); do
    [ -f "$FAKE/port" ] && break
    sleep 0.05
  done
  [ -f "$FAKE/port" ] || { fail "fake backend didn't start"; return 1; }
  printf 'http://127.0.0.1:%s\n' "$(cat "$FAKE/port")" > "$FIXTURE/fleet/host/parent"
}

# answer <response-json> [output-file-count] — one step answering 200.
answer() {
  local files='[]' i
  for i in $(seq 0 $((${2:-0} - 1))); do
    files=$(jq -c --arg f "png-$i" '. + [$f]' <<<"$files")
  done
  jq -cn --argjson b "$1" --argjson f "$files" '{status: 200, body: $b, files: $f}'
}

envelope() { cat "$FAKE/envelope.json"; }
calls() { cat "$FAKE/calls.log" 2>/dev/null; }

# ---------------------------------------------------------------------------
# fleet-service
# ---------------------------------------------------------------------------

test_request_shape_and_success() {
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{"hello":"world"}}')]"
  local out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --input '{"a":1}' --timeout 10)
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq '{"service":"echo","input":{"a":1}}' "$(envelope | jq -c .)" "request JSON"
  assert_eq '{"hello":"world"}' "$(jq -c .result <<<"$out")" "result on stdout"
  assert_eq "[]" "$(jq -c .files <<<"$out")" "no files"
  grep -q "^POST /agent-services/v1/jobs/[0-9a-f-]\{36\}?wait=1 auth=Bearer $CREDENTIAL\$" <<<"$(calls)" ||
    fail "POST with the machine credential not seen: $(calls)"
  grep -q "^DELETE /agent-services/v1/jobs/" <<<"$(calls)" || fail "answer not released"
}

test_credential_not_on_command_line() {
  # The credential goes through a header file, never curl's argv.
  grep -q 'Bearer %s' "$FLEET_SERVICE" || fail "credential not written to a header file"
  grep -q -- '-H @"$work/auth"' "$FLEET_SERVICE" || fail "curl doesn't read the header from a file"
}

test_as_user_goes_in_the_request() {
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{}}')]"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --as alice --timeout 10 >/dev/null
  assert_eq "alice" "$(envelope | jq -r .as_user)" "as_user"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 10 >/dev/null
  assert_eq "false" "$(envelope | jq -r 'has("as_user")')" "no as_user by default"
}

test_input_from_stdin_keeps_special_characters() {
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{}}')]"
  local msg=$'quotes " and \' and $HOME and\nnewlines'
  jq -cn --arg m "$msg" '{m: $m}' | HOME="$FIXTURE" "$FLEET_SERVICE" call echo --input - --timeout 10 >/dev/null
  assert_eq "$msg" "$(envelope | jq -r .input.m)" "message round-trips"
}

test_attachment_sent_in_its_slot() {
  printf 'img' > "$FIXTURE/cat.PNG"
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{}}')]"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --attach "ref=$FIXTURE/cat.PNG" --timeout 10 >/dev/null
  assert_eq "ref.png" "$(jq -r .ref.filename "$FAKE/attachments.json")" "slot filename (extension lower-cased)"
  assert_eq "img" "$(jq -r .ref.content "$FAKE/attachments.json")" "attachment bytes"
}

test_output_files_downloaded_and_paths_returned() {
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{}}' 2)]"
  local out
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 10 --out-dir "$FIXTURE/out")
  assert_eq 2 "$(jq '.files | length' <<<"$out")" "two files returned"
  local f
  for f in $(jq -r '.files[]' <<<"$out"); do
    case "$f" in "$FIXTURE/out/"*) ;; *) fail "file not under out-dir: $f";; esac
    [ -f "$f" ] || fail "returned file missing: $f"
  done
  assert_eq "png-1" "$(cat "$(jq -r '.files[1]' <<<"$out")")" "second file contents"
}

test_waits_through_running_answers() {
  fake_backend "[{\"status\":202},{\"status\":202},$(answer '{"ok":true,"service":"echo","result":{"n":1}}')]"
  local out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 10)
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq 1 "$(jq -r .result.n <<<"$out")" "answer after waiting"
  assert_eq "POST GET GET DELETE" "$(calls | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')" "posts once, then asks by ID"
}

test_caller_chosen_id() {
  fake_backend "[$(answer '{"ok":true,"service":"echo","result":{}}')]"
  local id=0b9f3c2e-1d4a-4c8b-9e7f-123456789abc
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --id "${id^^}" --timeout 10 >/dev/null
  grep -q "^POST /agent-services/v1/jobs/$id?" <<<"$(calls)" || fail "caller's ID (lower-cased) not used: $(calls)"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --id nope --timeout 10 >/dev/null 2>&1
  assert_eq 2 $? "a non-UUID --id is a usage error"
}

test_collect_only_asks_by_id() {
  fake_backend "[{\"status\":202},$(answer '{"ok":true,"service":"echo","result":{"n":2}}' 1)]"
  local id=0b9f3c2e-1d4a-4c8b-9e7f-123456789abc out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" collect "$id" --timeout 10 --out-dir "$FIXTURE/out")
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq 2 "$(jq -r .result.n <<<"$out")" "answer collected"
  assert_eq "$FIXTURE/out/$id-0.png" "$(jq -r '.files[0]' <<<"$out")" "output file saved"
  assert_eq 0 "$(calls | grep -c '^POST ')" "collect never sends the request"
}

test_collect_reports_lost() {
  fake_backend '[{"status":404,"body":{"ok":false,"service":null,"error":{"code":"lost","message":"gone"}}}]'
  local out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" collect 0b9f3c2e-1d4a-4c8b-9e7f-123456789abc --timeout 10)
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "lost" "$(jq -r .error.code <<<"$out")" "error code"
  HOME="$FIXTURE" "$FLEET_SERVICE" collect not-a-uuid >/dev/null 2>&1
  assert_eq 2 $? "a non-UUID is a usage error"
}

test_broken_call_then_only_asks_by_id() {
  # The connection breaks after the request may have arrived: it is never
  # sent again (a restarted backend would run it twice), only asked about.
  fake_backend "[{\"drop\":true},{\"status\":503,\"body\":{\"ok\":false,\"error\":{\"code\":\"starting\"}}},$(answer '{"ok":true,"service":"echo","result":{}}')]"
  local status
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 20 >/dev/null
  status=$?
  assert_eq 0 "$status" "succeeds once the backend answers"
  assert_eq "POST GET GET DELETE" "$(calls | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')" "sent once, then asked by ID"
}

test_bare_server_error_then_only_asks_by_id() {
  # A server error that isn't one of our answers (a proxy page): the backend
  # may have the request, so it's asked about, never sent again.
  fake_backend "[{\"status\":500,\"body\":{\"oops\":true}},$(answer '{"ok":true,"service":"echo","result":{}}')]"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 20 >/dev/null
  assert_eq 0 $? "exit status"
  assert_eq "POST GET DELETE" "$(calls | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')" "sent once, then asked by ID"
}

test_resends_while_the_app_is_starting() {
  fake_backend "[{\"status\":503,\"body\":{\"ok\":false,\"error\":{\"code\":\"starting\"}}},$(answer '{"ok":true,"service":"echo","result":{}}')]"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 20 >/dev/null
  assert_eq 0 $? "exit status"
  assert_eq 2 "$(calls | grep -c '^POST ')" "a request the app hadn't taken yet is sent again"
}

test_failure_response_exits_1() {
  fake_backend "[$(answer '{"ok":false,"service":"echo","error":{"code":"malformed","message":"nope"}}')]"
  local out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 10)
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "malformed" "$(jq -r .error.code <<<"$out")" "error code"
  assert_eq "false" "$(jq -r 'has("files")' <<<"$out")" "no files key on failure"
}

test_refusals_pass_through() {
  local code
  for code in revoked unauthorized lost; do
    local http=401
    [ "$code" = revoked ] && http=403
    [ "$code" = lost ] && http=404
    fake_backend "$(jq -cn --argjson h "$http" --arg c "$code" '[{status: $h, body: {ok: false, service: null, error: {code: $c, message: "why"}}}]')"
    local out status
    out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 10)
    status=$?
    assert_eq 1 "$status" "$code exit status"
    assert_eq "$code" "$(jq -r .error.code <<<"$out")" "$code code"
    assert_eq "echo" "$(jq -r .service <<<"$out")" "$code names the service"
    stop_backend
    rm -f "$FAKE/port" "$FAKE/calls.log"
  done
}

test_unreachable_when_nothing_listens() {
  printf 'http://127.0.0.1:9\n' > "$FIXTURE/fleet/host/parent"
  local out status
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 2)
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "unreachable" "$(jq -r .error.code <<<"$out")" "error code"
}

test_timeout_when_accepted_but_unanswered() {
  fake_backend '[{"status":202}]'
  local out
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 2)
  assert_eq "timeout" "$(jq -r .error.code <<<"$out")" "error code"
  grep -q "fleet-service collect " <<<"$(jq -r .error.message <<<"$out")" || fail "timeout doesn't say how to collect the answer"
  assert_eq 0 "$(calls | grep -c '^DELETE ')" "an unfinished request is left to collect"
}

test_not_set_up_without_credential_or_address() {
  rm -f "$FIXTURE/fleet/host/service-credential"
  printf 'http://127.0.0.1:9\n' > "$FIXTURE/fleet/host/parent"
  local out
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 2)
  assert_eq "not_set_up" "$(jq -r .error.code <<<"$out")" "no credential"
  printf '%s\n' "$CREDENTIAL" > "$FIXTURE/fleet/host/service-credential"
  rm -f "$FIXTURE/fleet/host/parent"
  out=$(HOME="$FIXTURE" "$FLEET_SERVICE" call echo --timeout 2)
  assert_eq "not_set_up" "$(jq -r .error.code <<<"$out")" "no address"
}

test_usage_errors_exit_2() {
  HOME="$FIXTURE" "$FLEET_SERVICE" call >/dev/null 2>&1
  assert_eq 2 $? "missing service"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --input '{bad' >/dev/null 2>&1
  assert_eq 2 $? "invalid input JSON"
  HOME="$FIXTURE" "$FLEET_SERVICE" call echo --attach nofile >/dev/null 2>&1
  assert_eq 2 $? "bad --attach"
}

# ---------------------------------------------------------------------------
# agent-phone
# ---------------------------------------------------------------------------

test_agent_phone_success() {
  fake_backend "[$(answer '{"ok":true,"service":"agent-phone","result":{"outcome":"completed","transcript":"voice: hi\nuser: ok","call_length_seconds":12}}')]"
  local out err status
  out=$(HOME="$FIXTURE" "$AGENT_PHONE" --to alice --from "Clipper" "Build failed" 2>"$FIXTURE/err")
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq "agent-phone" "$(envelope | jq -r .service)" "service"
  assert_eq '{"caller_name":"Clipper","to_user":"alice","message":"Build failed"}' \
    "$(envelope | jq -c .input)" "input"
  assert_eq $'voice: hi\nuser: ok' "$out" "transcript on stdout"
  err=$(cat "$FIXTURE/err")
  assert_eq "completed" "$(jq -r .outcome <<<"$err")" "metadata on stderr"
}

test_agent_phone_failure_shape() {
  fake_backend "[$(answer '{"ok":false,"service":"agent-phone","error":{"code":"no_answer","message":"rang out","call_length_seconds":30}}')]"
  local out status
  out=$(HOME="$FIXTURE" "$AGENT_PHONE" --to alice --from "Clipper" "hi" 2>"$FIXTURE/err")
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "" "$out" "nothing on stdout"
  assert_eq '{"outcome":"no_answer","message":"rang out","call_length_seconds":30}' \
    "$(cat "$FIXTURE/err")" "outcome JSON on stderr"
}

test_agent_phone_message_from_stdin() {
  fake_backend "[$(answer '{"ok":true,"service":"agent-phone","result":{"outcome":"no_response","transcript":""}}')]"
  printf 'line one\nline two' | HOME="$FIXTURE" "$AGENT_PHONE" --to alice --from "Clipper" - >/dev/null 2>&1
  assert_eq $'line one\nline two' "$(envelope | jq -r .input.message)" "message from stdin"
}

test_agent_phone_requires_flags() {
  HOME="$FIXTURE" "$AGENT_PHONE" --from "Clipper" "hi" >/dev/null 2>&1
  assert_eq 2 $? "missing --to"
  HOME="$FIXTURE" "$AGENT_PHONE" --to alice "hi" >/dev/null 2>&1
  assert_eq 2 $? "missing --from"
  HOME="$FIXTURE" "$AGENT_PHONE" --to alice --from x >/dev/null 2>&1
  assert_eq 2 $? "missing message"
}

# ---------------------------------------------------------------------------
# image-gen
# ---------------------------------------------------------------------------

test_image_gen_success_default_outputs() {
  fake_backend "[$(answer '{"ok":true,"service":"image-gen","result":{"size":"1024x1024","model":"gpt-image-1.5","n":2,"generation_time_ms":5}}' 2)]"
  local out status
  out=$(HOME="$FIXTURE" IMAGE_GEN_TIMEOUT_SEC=10 "$IMAGE_GEN" "a cat" --n 2 --size 512x512 2>"$FIXTURE/err")
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq '{"prompt":"a cat","size":"512x512","n":2}' "$(envelope | jq -c .input)" "input"
  assert_eq 2 "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "two paths on stdout"
  local p
  while IFS= read -r p; do
    case "$p" in "$FIXTURE/fleet/image-gen-outputs/"*) ;; *) fail "unexpected output path: $p";; esac
    [ -f "$p" ] || fail "output missing: $p"
  done <<<"$out"
  assert_eq "gpt-image-1.5" "$(jq -r .model "$FIXTURE/err")" "metadata on stderr"
  assert_eq 2 "$(jq '.images | length' "$FIXTURE/err")" "metadata lists images"
}

test_image_gen_out_and_ref() {
  printf 'ref' > "$FIXTURE/base.png"
  fake_backend "[$(answer '{"ok":true,"service":"image-gen","result":{}}' 2)]"
  local out
  out=$(HOME="$FIXTURE" IMAGE_GEN_TIMEOUT_SEC=10 "$IMAGE_GEN" "edit" --ref "$FIXTURE/base.png" --out "$FIXTURE/pics/x.png" 2>/dev/null)
  assert_eq "$FIXTURE/pics/x.png"$'\n'"$FIXTURE/pics/x-1.png" "$out" "--out naming"
  [ -f "$FIXTURE/pics/x-1.png" ] || fail "second image not moved"
  assert_eq "ref" "$(jq -r .ref.content "$FAKE/attachments.json")" "ref attachment sent"
}

test_image_gen_failure_shape() {
  fake_backend "[$(answer '{"ok":false,"service":"image-gen","error":{"code":"content_blocked"}}')]"
  local out status
  out=$(HOME="$FIXTURE" IMAGE_GEN_TIMEOUT_SEC=10 "$IMAGE_GEN" "bad" 2>"$FIXTURE/err")
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "" "$out" "nothing on stdout"
  assert_eq '{"reason":"content_blocked"}' "$(cat "$FIXTURE/err")" "failure JSON on stderr"
}

test_image_gen_json_escape_hatch() {
  printf '{\n  "prompt": "from file",\n  "requested_at": "2026-01-01T00:00:00Z",\n  "quality": "high"\n}\n' > "$FIXTURE/in.json"
  fake_backend "[$(answer '{"ok":true,"service":"image-gen","result":{}}' 1)]"
  HOME="$FIXTURE" IMAGE_GEN_TIMEOUT_SEC=10 "$IMAGE_GEN" --json "$FIXTURE/in.json" >/dev/null 2>&1
  assert_eq '{"prompt":"from file","quality":"high"}' "$(envelope | jq -c .input)" "input from file"
}

# ---------------------------------------------------------------------------
# stt
# ---------------------------------------------------------------------------

STT_OK='{"ok":true,"service":"stt","result":{"text":"hello\nworld","provider":"elevenlabs","audio_bytes":5,"transcription_time_ms":7}}'

test_stt_success() {
  printf 'audio' > "$FIXTURE/memo.ogg"
  fake_backend "[$(answer "$STT_OK")]"
  local out status
  out=$(HOME="$FIXTURE" STT_TIMEOUT_SEC=10 "$STT" "$FIXTURE/memo.ogg" 2>"$FIXTURE/err")
  status=$?
  assert_eq 0 "$status" "exit status"
  assert_eq $'hello\nworld' "$out" "transcript on stdout"
  assert_eq '{}' "$(envelope | jq -c .input)" "input"
  assert_eq "audio.ogg" "$(jq -r .audio.filename "$FAKE/attachments.json")" "audio attachment sent"
  assert_eq '{"provider":"elevenlabs","audio_bytes":5,"transcription_time_ms":7}' "$(cat "$FIXTURE/err")" "metadata on stderr"
}

test_stt_out_file() {
  printf 'audio' > "$FIXTURE/memo.ogg"
  fake_backend "[$(answer "$STT_OK")]"
  local out
  out=$(HOME="$FIXTURE" STT_TIMEOUT_SEC=10 "$STT" "$FIXTURE/memo.ogg" --out "$FIXTURE/notes/memo.txt" 2>"$FIXTURE/err")
  assert_eq "" "$out" "nothing on stdout"
  assert_eq $'hello\nworld' "$(cat "$FIXTURE/notes/memo.txt")" "transcript in --out"
  assert_eq "$FIXTURE/notes/memo.txt" "$(jq -r .out "$FIXTURE/err")" "metadata names --out"
}

test_stt_failure_shape() {
  printf 'audio' > "$FIXTURE/memo.ogg"
  fake_backend "[$(answer '{"ok":false,"service":"stt","error":{"code":"transcription_failed","message":"nope"}}')]"
  local out status
  out=$(HOME="$FIXTURE" STT_TIMEOUT_SEC=10 "$STT" "$FIXTURE/memo.ogg" 2>"$FIXTURE/err")
  status=$?
  assert_eq 1 "$status" "exit status"
  assert_eq "" "$out" "nothing on stdout"
  assert_eq '{"reason":"transcription_failed","message":"nope"}' "$(cat "$FIXTURE/err")" "failure JSON on stderr"
}

test_stt_usage_errors() {
  HOME="$FIXTURE" "$STT" 2>/dev/null
  assert_eq 2 "$?" "no file"
  HOME="$FIXTURE" "$STT" "$FIXTURE/missing.mp3" 2>/dev/null
  assert_eq 2 "$?" "missing file"
  HOME="$FIXTURE" "$STT" --bogus 2>/dev/null
  assert_eq 2 "$?" "unknown flag"
}

printf '=== agent-services helper tests ===\n'
run_test test_request_shape_and_success
run_test test_credential_not_on_command_line
run_test test_as_user_goes_in_the_request
run_test test_input_from_stdin_keeps_special_characters
run_test test_attachment_sent_in_its_slot
run_test test_output_files_downloaded_and_paths_returned
run_test test_waits_through_running_answers
run_test test_caller_chosen_id
run_test test_collect_only_asks_by_id
run_test test_collect_reports_lost
run_test test_broken_call_then_only_asks_by_id
run_test test_bare_server_error_then_only_asks_by_id
run_test test_resends_while_the_app_is_starting
run_test test_failure_response_exits_1
run_test test_refusals_pass_through
run_test test_unreachable_when_nothing_listens
run_test test_timeout_when_accepted_but_unanswered
run_test test_not_set_up_without_credential_or_address
run_test test_usage_errors_exit_2
run_test test_agent_phone_success
run_test test_agent_phone_failure_shape
run_test test_agent_phone_message_from_stdin
run_test test_agent_phone_requires_flags
run_test test_image_gen_success_default_outputs
run_test test_image_gen_out_and_ref
run_test test_image_gen_failure_shape
run_test test_image_gen_json_escape_hatch
run_test test_stt_success
run_test test_stt_out_file
run_test test_stt_failure_shape
run_test test_stt_usage_errors

printf '\nPASS: %s  FAIL: %s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
