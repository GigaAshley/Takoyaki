// The open-mic pill in the composer's bottom row. The button the user pressed
// (the mic for dictation, the voice-mode button for voice mode) grows into
// this pill and it holds only what an open mic needs, icons only:
//
//   [✕ end] [live trace ──────] [pause / play] [add to text | skip]
//
// Dictation is red; voice mode is blue while it listens, green while a reply
// is read aloud (the trace then shows the reply's audio), and grey while
// paused. A spinner sits at the start of the trace while the mic is opening
// or words are being sent. Every button keeps its place in every state, so
// nothing moves under a finger — Skip is greyed out until there's a reply
// to skip (being read, or frozen by a pause). The state in words is the composer's screen-reader status, not here.

import { useEffect, useRef } from "react";
import { ArrowDownToLine, LoaderCircle, Pause, Play, SkipForward, X } from "lucide-react";
import { MicWaveform } from "./MicWaveform";

export type MicPillKind = "dictate" | "voice";

export interface MicPillProps {
  kind: MicPillKind;
  /** Level for the trace (see MicWaveform). */
  readLevel: () => number | null;
  /** ✕ — dictation: cancel and throw the recording away; voice mode: end it. */
  onEnd: () => void;
  paused: boolean;
  onTogglePause: () => void;
  pauseDisabled?: boolean;
  /** The mic is opening or words are being sent: spinner before the trace. */
  busy?: boolean;
  /** Voice mode: a reply is being read aloud (green trace, Skip live). */
  speaking?: boolean;
  /** Dictation: stop and add the words to the text box. */
  onAppend?: () => void;
  appendDisabled?: boolean;
  /** Voice mode: skip what is being read aloud. */
  onSkip?: () => void;
  /** Voice mode: there's a reply to skip (defaults to `speaking`). */
  skipEnabled?: boolean;
}

export function MicPill({
  kind,
  readLevel,
  onEnd,
  paused,
  onTogglePause,
  pauseDisabled,
  busy = false,
  speaking = false,
  onAppend,
  appendDisabled,
  onSkip,
  skipEnabled = speaking,
}: MicPillProps) {
  const dictate = kind === "dictate";
  // The button that opened the pill is gone; if focus went with it, it lands
  // on Pause so the keyboard stays in the pill.
  const pauseRef = useRef<HTMLButtonElement | null>(null);
  // Which sound the trace shows. A pause keeps the trace it had, so it goes
  // flat and grey instead of starting over empty.
  const sourceRef = useRef<"reply" | "mic">(speaking ? "reply" : "mic");
  if (!paused) sourceRef.current = speaking ? "reply" : "mic";
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) pauseRef.current?.focus();
  }, []);
  const tone = paused ? "paused" : speaking ? "speaking" : "live";
  const what = dictate ? "recording" : "voice mode";
  return (
    <div
      className="pv-mic-pill"
      data-testid="mic-pill"
      data-kind={kind}
      data-tone={tone}
      data-busy={busy ? "true" : undefined}
    >
      <button
        type="button"
        className="pv-mic-pill-btn pv-mic-pill-end"
        onClick={onEnd}
        aria-label={dictate ? "Cancel recording" : "End voice mode"}
        title={dictate ? "Cancel recording" : "End voice mode"}
        data-testid="mic-pill-end"
      >
        <X strokeWidth={2.25} aria-hidden="true" />
      </button>
      <div className="pv-mic-pill-trace">
        {busy && <LoaderCircle aria-hidden="true" className="pv-mic-pill-spin animate-spin" />}
        {/* A fresh trace per source: the reply's sound and the mic each
            stay hidden until they give a reading of their own. */}
        <MicWaveform key={sourceRef.current} read={readLevel} />
      </div>
      <button
        ref={pauseRef}
        type="button"
        className="pv-mic-pill-btn"
        onClick={onTogglePause}
        disabled={pauseDisabled}
        aria-label={paused ? `Resume ${what}` : `Pause ${what}`}
        title={paused ? "Resume" : "Pause"}
        data-testid="mic-pill-pause"
      >
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      </button>
      {dictate ? (
        <button
          type="button"
          className="pv-mic-pill-btn"
          onClick={onAppend}
          disabled={appendDisabled}
          aria-label="Add to text"
          title="Add to text"
          data-testid="mic-pill-append"
        >
          <ArrowDownToLine aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="pv-mic-pill-btn pv-mic-pill-skip"
          onClick={onSkip}
          disabled={!skipEnabled}
          aria-label="Skip what's being read"
          title="Skip"
          data-testid="mic-pill-skip"
        >
          <SkipForward aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
