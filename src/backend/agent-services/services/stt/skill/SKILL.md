---
name: stt
description: Transcribe an audio file (voice memo, call recording, meeting audio) to text via the fleet's speech-to-text provider. Invoke as `stt <audio-file>`.
distributed: true
---

# stt

Speech to text: turn an audio file into a transcript. Invoked as a one-line shell helper; the request and response files are handled inside it.

## Invocation

The helper is `stt`, on your `PATH` (`~/.local/bin/stt`):

```
stt /path/to/recording.m4a
stt /path/to/meeting.mp3 --out ~/fleet/notes/meeting.txt
```

- `<audio-file>`: flac, m4a, mp3, mp4, oga, ogg, opus, wav or webm, up to 25 MB. For a video or another format, extract the audio first, e.g. `ffmpeg -i in.mov -vn -c:a libopus out.ogg`. For a longer recording, split it into pieces under 25 MB and transcribe each.
- `--out <path>`: write the transcript to this file instead of stdout.

Model and language are instance settings; there are no flags for them.

Before invoking: confirm the recording contains nothing compliance-restricted. See the directive at the top of this file.

## Response shape

- **Success**: exit `0`. The transcript on **stdout** (or in `--out`). Metadata JSON `{provider, audio_bytes, transcription_time_ms, out?}` on **stderr**.
- **Failure**: non-zero exit. A JSON object `{reason, message?}` on **stderr**; nothing on stdout.

```
text=$(stt memo.m4a)
```

The helper waits up to 9 minutes, under the Bash tool's 10-minute limit, and cleans up its scratch files on every exit path.

## Failure handling

| reason | caller action |
| --- | --- |
| malformed | Read `message`: usually an unsupported file type (`attachment audio ...`) or a file over 25 MB. Convert or split, then retry. |
| transcription_failed | The provider could not transcribe the file. Check it actually contains audio (`ffprobe <file>`); re-encode it (e.g. to ogg/opus) and retry once. |
| provider_unavailable | The provider is busy or unreachable (the backend already retried). Retry after a brief delay. |
| provider_rejected | The provider rejected the backend's key or is out of credit. Escalate to the operator. |
| not_configured | Speech to text isn't set up yet (no provider or key). Escalate to the operator: an admin sets it up in Admin → Services. |
| not_enabled | Speech to text isn't switched on for this machine. Not agent-retriable: tell the user an admin can switch it on in Admin → Services. |
| expired | The request waited in the queue past 2 minutes. Retry; the fleet may be busy. |
| timeout | The backend accepted the request but did not answer within 9 minutes. It keeps going: `fleet-service collect <id>` (the ID is in `message`) gets the transcript later. |
| lost | The backend restarted while the request was in flight, so its answer is gone; it was not run again. Retry. |
| unreachable | The backend couldn't be reached from this machine (the helper kept trying until its time ran out). Retry later; if it keeps happening, escalate to the operator. |
| not_set_up | This machine hasn't been given its service credential yet (it arrives within a minute of the machine being set up), or an admin revoked it. Retry in a minute; if it persists, escalate to the operator. |
| revoked | An admin revoked this machine's access to services. Not agent-retriable: tell the user an admin can issue it a new credential in Admin → Services. |
| queue_full | Too many requests queued. Retry later. |
| internal | Escalate to the operator. |
