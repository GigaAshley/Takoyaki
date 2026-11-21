// Mic for the tray's "Something else" field, inside the field's right end: tap
// to record; while recording it shows the composer's "add to text" arrow, and
// tapping it stops and adds the words to the end of the field. Never sends — the user
// checks the text and presses Send. Same recorder as the composer's mic, and
// the same one-mic-at-a-time rule (voice-mode-registry).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, LoaderCircle, Mic } from "lucide-react";
import { useVoiceRecording, type VoiceLogContext } from "../useVoiceRecording";
import {
  registerManualRecording,
  useManualRecordingAnywhere,
  useVoiceModeActiveAnywhere,
} from "../voice-mode-registry";

export interface AskOtherMicProps {
  /** The field's current text; the transcript is added after it. */
  text: string;
  onText: (text: string) => void;
  logContext?: VoiceLogContext;
  disabled?: boolean;
  /** The field itself; the mic sits inside its right end. */
  children: ReactNode;
}

/** `text` + `transcript`, joined by one space unless `text` already ends in whitespace. */
export function appendTranscript(text: string, transcript: string): string {
  if (transcript === "") return text;
  if (text === "" || /\s$/.test(text)) return text + transcript;
  return `${text} ${transcript}`;
}

export function AskOtherMic({ text, onText, logContext, disabled, children }: AskOtherMicProps) {
  const voice = useVoiceRecording(logContext);
  // The field can change while the words are being transcribed; add them to
  // what it holds when they arrive.
  const textRef = useRef(text);
  textRef.current = text;

  const busyHere = voice.state !== "idle";
  const [tokenHere] = useState(() => Symbol("ask-other-mic"));
  useEffect(() => {
    if (!busyHere) return;
    return registerManualRecording(tokenHere);
  }, [busyHere, tokenHere]);
  const voiceModeAnywhere = useVoiceModeActiveAnywhere();
  const recordingAnywhere = useManualRecordingAnywhere();
  const blockedByOther = !busyHere && (voiceModeAnywhere || recordingAnywhere);

  // Leaving the field (another tab, back to the choices, Send, a new
  // question) drops a recording still running — including one still waiting
  // for the mic ("starting"), whose stream is on its way; the
  // recorder doesn't let go of the mic on its own. Words still being written
  // down are dropped too, so they can't land on an answer that moved on.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (startedRef.current || voiceRef.current.state !== "idle") {
        console.info(`[ask] other-mic-drop reason=field-closed state=${voiceRef.current.state}`);
        void voiceRef.current.cancel({ silent: true });
      }
    };
  }, []);

  async function stop() {
    console.info(`[ask] other-mic-stop hostId=${logContext?.hostId ?? "null"} sessionId=${logContext?.sessionId ?? "null"}`);
    const result = await voice.endAppend(textRef.current);
    startedRef.current = false;
    if (!mountedRef.current) {
      console.info(`[ask] other-mic-drop reason=field-closed-while-transcribing`);
      return;
    }
    if (!result) return; // errorMessage is set on the hook
    onText(appendTranscript(textRef.current, result.transcript));
  }

  function onClick() {
    // The mic is still opening: nothing to stop yet.
    if (voice.state === "starting") return;
    if (voice.state === "recording") {
      void stop();
      return;
    }
    if (voice.state !== "idle") return;
    console.info(`[ask] other-mic-start hostId=${logContext?.hostId ?? "null"} sessionId=${logContext?.sessionId ?? "null"}`);
    // No await before start() — iOS only grants the mic from the tap itself.
    voice.start();
    startedRef.current = true;
  }

  const recording = voice.state === "recording" || voice.state === "starting";
  const transcribing = voice.state === "transcribing";
  const label = recording ? "Stop and add to your answer" : transcribing ? "Writing it down…" : "Say your answer";
  const title = blockedByOther
    ? voiceModeAnywhere ? "Voice mode is on" : "A mic is recording"
    : label;
  return (
    <>
      <div className="pv-ask-other-field">
        {children}
        <button
          type="button"
          className="pv-ask-mic"
          data-recording={recording ? "true" : undefined}
          aria-label={label}
          title={title}
          // Its own recording can always be stopped, even if the tray greys out meanwhile.
          disabled={(disabled && !recording) || blockedByOther || transcribing}
          onClick={onClick}
          data-testid="ask-other-mic"
        >
          {transcribing ? <LoaderCircle className="pv-ask-mic-spin" aria-hidden="true" />
            : recording ? <ArrowDownToLine aria-hidden="true" />
            : <Mic aria-hidden="true" />}
        </button>
      </div>
      {voice.errorMessage && !busyHere && (
        <span className="pv-ask-mic-error" role="status">{voice.errorMessage}</span>
      )}
    </>
  );
}
