/**
 * useVoiceMode — hands-free, back-and-forth voice conversation with a session.
 *
 * Toggled by the voice-mode button in the ComposeBox aux row. Once on, the loop is:
 *
 *   listening ──(speech)──▶ hearing ──(turn ends)──▶ transcribing ──▶ send(draft)
 *       ▲                                                                 │
 *       └──── speaking ◀── new assistant messages (identity voice TTS) ◀──┘
 *
 * v2 (shape-voice-mode-v2, 2026-10-10) — "let me take my time":
 *   - Pieces. A short pause (PIECE_GAP_MS) closes the current piece of audio and
 *     a fresh recorder starts at once (the user is silent, so nothing falls in
 *     the gap). Each closed piece is transcribed in the background and joins
 *     the draft in spoken order. A piece with no words (sneeze, cough, bump) is
 *     dropped silently — no cue, nothing sent.
 *   - Turn end is the user's preference (voice-mode-settings.ts):
 *       timed  — the user's pause length (default TIMED_END_MS) of silence
 *                after a draft exists sends it;
 *       phrase — silence never sends; a piece ending in the send phrase does
 *                (phrase stripped). The phrase only works in this mode.
 *     Either way the draft goes only once every earlier piece has resolved.
 *   - A piece ending in "stop voice mode" (or a variant) turns voice mode off
 *     and throws the draft away.
 *   - Each piece waits for the server's answer for as long as the server
 *     itself keeps trying (TRANSCRIBE_WAIT_MS), sending the piece again only
 *     when it never reached the server. If it still can't be transcribed,
 *     voice mode bails: off, error cue, and every piece that WAS transcribed
 *     goes into the compose box (unsent) with the gap marked. Nothing
 *     half-finished ever reaches the agent.
 *   - The moment the turn ends (chip: Sending) the send cue plays and the
 *     working ticks start, carrying on through transcription and the agent's
 *     work.
 *   - While a draft is in progress, replies wait and the working ticks stay
 *     quiet.
 *   - Cues (voice-mode-cues.ts) play through this hook's AudioContext, which
 *     start() unlocks inside the tap — so they work on iOS with the mic open.
 *
 * Standing design rules (user 2026-10-06: "the voice mode doesn't take over
 * anything it doesn't have to"):
 *   - Owns its OWN MediaStream + MediaRecorders. It never touches the compose
 *     textarea, attachments or the tap-to-record `useVoiceRecording`
 *     instance, so typing / pasting / Send keep working while voice mode is on.
 *     Replies to typed sends are spoken too.
 *   - One mic listener at a time: while voice mode is on, ComposeBox disables
 *     every mic (voice-mode-registry.ts). `suspended` (manual mic in use →
 *     listening pauses) is kept as a fallback.
 *   - Half-duplex: the recorder is stopped while TTS plays (iOS Safari shares one
 *     AudioSession between MediaRecorder and playback — see the AudioSession-
 *     safety notes in useVoiceRecording.ts) and so the agent never hears itself.
 *     The MediaStream itself stays open for the whole session so the mic never
 *     needs another user gesture.
 *   - A speak button talking (bubble or file "read aloud", tapped before or
 *     during voice mode) counts as speaking: listening stops, the chip shows
 *     Speaking, replies wait for it, and when it finishes it's "your turn".
 *     Pausing it hands the turn back (listening resumes).
 *   - Pause (the chip's pause button) holds everything as it is: a reply
 *     freezes mid-sentence (one with no audio yet goes back to the front of
 *     the queue), a speak button talking is paused through its own pause,
 *     what the user said so far is kept, listening stops (mic open, tracks
 *     disabled), replies wait and the ticks go quiet. Sending and the agent's
 *     work carry on. Resume carries on where it was; back into listening
 *     plays "your turn".
 *   - The phone taking the audio (a call: the mic is muted or ended, or the
 *     AudioContext goes "interrupted"; or exact-zero sound for DEAD_SOUND_MS)
 *     is the same pause, and the mic is let go. When the phone gives the
 *     sound back (the interrupted context runs again — the call watch nudges
 *     it), voice mode carries on by itself: iOS hands the mic back without a
 *     tap then. The play tap does the same at any time, inside the gesture.
 *     If taking the mic back fails, it stays paused and says so. A pause the
 *     user made never carries on by itself.
 *   - Holds a screen wake lock: mobile browsers suspend the page (and kill the
 *     mic) when the screen locks, so "phone in pocket" needs the screen kept on.
 *
 * start() is called from the button's click, so the VAD/cue AudioContext and
 * the "on" chime are unlocked inside a user gesture.
 */

import { askSpeech, lastAskBody, parseAskBlock } from "./ask/ask-format";
import { useCallback, useEffect, useRef, useState } from "react";
import { stampedFetch } from "@/lib/stamped-fetch";
import { postSpeakStream } from "../../api/voice-api";
import { playAutoSpeakOff, playAutoSpeakOn } from "../../audio/auto-speak-cue";
import { createWebAudioStreamPlayer } from "./webAudioStreamPlayer";
import {
  clearCurrentPlayer,
  getButtonSpeechState,
  getCurrentOwner,
  getCurrentPlayer,
  pauseButtonSpeech,
  resumeButtonSpeech,
  setCurrentOwner,
  setCurrentPlayer,
  subscribeHeard,
  subscribeSpeech,
} from "./speak-singleton";
import { buildHeardNote, sameReply, type HeardReply, type RunEntry } from "./heard-note";
import { stripVoiceLabel } from "./voice-label";
import { registerVoiceModeActive } from "./voice-mode-registry";
import { createVoiceModeCues, type VoiceModeCue, type VoiceModeCues } from "./voice-mode-cues";
import { getVoiceModeSettings, VOICE_MODE_PAUSE_SECONDS_DEFAULT } from "./voice-mode-settings";
import { describeMicTrack } from "./mic-level-monitor";
import { richSpeakable } from "./rich/rich-speech";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** VAD poll cadence. */
const VAD_TICK_MS = 50;
/** Voiced time needed before a piece counts as speech (filters clicks/bumps). */
const SPEECH_START_MS = 200;
/** A pause this long closes the current piece and starts the next. */
export const PIECE_GAP_MS = 1500;
/** Timed mode: default silence after a draft exists that ends the turn (the user can change it). */
export const TIMED_END_MS = VOICE_MODE_PAUSE_SECONDS_DEFAULT * 1000;
/** Safety cap on one piece of unbroken speech (the message itself has no cap). */
export const MAX_PIECE_MS = 5 * 60 * 1000;
/** Rotate the idle recorder so a quiet stretch never builds a huge clip. */
const IDLE_ROTATE_MS = 30 * 1000;
/**
 * Have the recorder hand over audio in slices while it runs, so a recorder
 * whose final data/onstop never arrive (iOS) still leaves its audio behind.
 */
export const RECORDER_TIMESLICE_MS = 1000;
/** How long a stopped recorder gets to deliver before its slices are used as-is. */
const RECORDER_STOP_WATCHDOG_MS = 8000;
/**
 * The server's overall limit on one transcription — both providers, all
 * retries (routes/voice.ts VOICE_TRANSCRIBE_DEADLINE_MS). Keep them equal.
 */
export const SERVER_TRANSCRIBE_LIMIT_MS = 3 * 60 * 1000;
/**
 * How long a piece waits for the server's answer: its limit plus a margin.
 * The server's clock starts only once the upload is in (a 5-minute piece is
 * ~5 MB — ~40 s on a slow phone uplink), and the first piece's "slash …"
 * rewrite runs after it (up to 10 s), so the margin covers both.
 */
export const TRANSCRIBE_WAIT_MS = SERVER_TRANSCRIBE_LIMIT_MS + 90 * 1000;
/** A piece that never reached the server is sent again: first wait, doubling up to the cap. */
const TRANSCRIBE_RESEND_FIRST_DELAY_MS = 1000;
const TRANSCRIBE_RESEND_MAX_DELAY_MS = 8000;
/** Where a piece that couldn't be transcribed sat, in words kept in the compose box. */
export const LOST_PIECE_MARKER = "[part of this couldn't be transcribed]";
/**
 * After a send, tick until the agent shows it is working (or replies), even if
 * it is still waking from dormancy — capped so a lost send can't tick forever.
 */
export const AWAIT_REPLY_MAX_MS = 2 * 60 * 1000;
/** Debounce on "your turn" after the agent goes idle — the last reply may still be landing. */
const YOUR_TURN_SETTLE_MS = 700;
/** RMS floor below which nothing counts as speech, regardless of noise floor. */
const MIN_SPEECH_RMS = 0.012;
/** Speech must be this many times louder than the tracked noise floor. */
const NOISE_MULTIPLIER = 3;
/**
 * Exact-zero sound for this long while listening means the phone stopped
 * passing the mic to the page (a working mic is never exactly silent).
 */
export const DEAD_SOUND_MS = 1500;
/** How long the play tap's mic request may take before voice mode stays paused and says so. */
export const RECOVER_MIC_TIMEOUT_MS = 6000;
/** Call watch (while paused by the phone): how often it looks, and for how long. */
export const CALL_WATCH_TICK_MS = 2000;
export const CALL_WATCH_MAX_MS = 15 * 60_000;

/** Why the mic is being asked for: voice mode starting, after the manual mic, or the play tap after an interruption. */
type MicRequestKind = "start" | "reacquire" | "recover";
/** History frames older than voice-mode start (minus slack) are never spoken. */
const HISTORY_SLACK_MS = 60 * 1000;
/**
 * User-role turns the user didn't type: wake-ups, relay and watcher events,
 * slash-command wrappers, harness reminders. They stay out of the heard run.
 */
const NOT_TYPED_RE = /<(task-notification|pasted_content|command-name|command-message|local-command-|system-reminder)/;
/** Heard-run steps kept per session — the note shows only the tail. */
const RUN_KEEP = 40;
/** Let the error cue finish before the AudioContext is closed. */
const ERROR_CUE_TAIL_MS = 1500;
/** Let the "off" chime finish before the AudioContext is closed. */
const OFF_TAIL_MS = 1000;

const TRANSCRIBE_URL = "/voice/transcribe";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceModePhase =
  | "off"
  | "starting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "speaking"
  | "paused";

/** Structural subset of PrettyView's StreamEvent that voice mode reads. */
export interface VoiceModeMessage {
  type: string;
  eventId?: string;
  role?: string;
  content?: unknown;
  ts?: number;
}

export interface UseVoiceModeArgs {
  hostId: number;
  tmuxSession?: string | null;
  /** Voice candidates for replies (identity → role → fallback); [] = provider default. */
  voices: readonly string[];
  /** Agent-working signal (session-working-store). */
  isWorking: boolean;
  /** The pane's message stream; new assistant messages are spoken. */
  messages: ReadonlyArray<VoiceModeMessage>;
  /** True while the manual tap-to-record mic is busy — listening pauses. */
  suspended: boolean;
  /**
   * Dispatch a transcript with its heard note (what the user had heard when
   * they spoke — heard-note.ts). Return false if it could not be sent, or
   * "refused" if it was deliberately not sent (a blocked command): no cue
   * plays, nothing is awaited and the words are dropped.
   */
  send: (text: string, heardNote: string) => boolean | "refused";
  /**
   * Words that didn't reach the agent: a draft that couldn't be sent, or what
   * was transcribed before voice mode bailed. Appended to the compose box;
   * `message` (bail) replaces the default note under it.
   */
  onUndelivered: (text: string, message?: string) => void;
}

export interface UseVoiceModeReturn {
  active: boolean;
  phase: VoiceModePhase;
  errorMessage: string | null;
  /** Call synchronously inside a user gesture (getUserMedia + audio unlock). */
  start: () => void;
  stop: () => void;
  /**
   * Voice mode is on hold: nothing is read aloud (a reply freezes mid-sentence),
   * nothing is listened to (the mic stays open but hears silence), replies
   * wait. Work already in flight carries on.
   */
  paused: boolean;
  togglePause: () => void;
  /**
   * Stop the reply being read aloud (or frozen by a pause); the next waiting
   * reply, if any, plays — once voice mode isn't paused.
   */
  skipSpeech: () => void;
  /** There is a reply being read, or one frozen by a pause, for Skip to drop. */
  canSkip: boolean;
  /**
   * Level (windowed RMS, 0–1) for the voice-mode trace: the reply's audio
   * while one is read aloud, otherwise the mic; 0 while paused; null when it
   * can't be read.
   */
  readLevel: () => number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXIT_PHRASE_AT_END =
  /(?:^| )(?:please )?(?:stop|end|exit|quit|close|turn off|cancel) (?:the )?voice mode(?: please)?$/;

/** True when a transcript ends with a spoken request to leave voice mode. */
export function endsWithExitPhrase(transcript: string): boolean {
  return EXIT_PHRASE_AT_END.test(normalizeSpeech(transcript));
}

/**
 * If `transcript` ends with `phrase` (ignoring capitals and punctuation),
 * return the transcript with the phrase removed; otherwise null.
 */
export function stripSendPhrase(transcript: string, phrase: string): string | null {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const target = phrase.split(/\s+/).map(norm).filter(Boolean);
  if (target.length === 0) return null;
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  let i = words.length - 1;
  for (let k = target.length - 1; k >= 0; k -= 1) {
    while (i >= 0 && norm(words[i]) === "") i -= 1; // stray punctuation
    if (i < 0 || norm(words[i]) !== target[k]) return null;
    i -= 1;
  }
  return words
    .slice(0, i + 1)
    .join(" ")
    .replace(/[\s,;:–—-]+$/u, "")
    .trim();
}

/**
 * Filler sounds, any length: um, uh, er(m), ah, oh, hm(m), mm, mhm, mm-hmm,
 * uh-huh, uh-uh. Speech-to-text models (Whisper on Groq especially) write
 * stray noise as these; a lone grunt yes/no is more likely noise than a reply.
 */
const FILLER_WORD = /^(?:u+m+|u+h+|e+r+m*|a+h+|o+h+|h+m+|m+|m+h+m+|u+h+u+h+)$/;

/** True when a transcript has letters and every word is a filler sound. */
export function isFillerOnly(transcript: string): boolean {
  const words = transcript
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  return words.length > 0 && words.every((w) => FILLER_WORD.test(w));
}

/**
 * Markdown → something pleasant to hear. Code blocks are announced rather than
 * read symbol by symbol; links read their label; formatting marks are dropped.
 */
export function toSpeakableText(markdown: string): string {
  const trayBody = lastAskBody(markdown)?.trimEnd() ?? null;
  const withAsk = markdown
    // An ask block is read as its question and choices (shape-interactive-responses).
    .replace(/^ {0,3}```[ \t]*ask[ \t]*\r?\n([\s\S]*?)^ {0,3}```[ \t]*$/gm, (block, body: string) => {
      if (body.trimEnd() !== trayBody) return block;
      const res = parseAskBlock(body);
      return res.ok ? ` Asked you: ${askSpeech(res.ask)} ` : block;
    });
  // Wealthy text reads as its spoken lines (shape-wealthy-text); runs before
  // the generic code-block drop so charts and diagrams aren't "omitted".
  return richSpeakable(withAsk)
    .replace(/```[\s\S]*?(```|$)/g, " (code block omitted) ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?[-:\s|]+\|[-:\s|]*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A reply waiting to be read aloud. */
interface QueuedReply {
  reply: HeardReply;
  speakable: string;
}

/** The pane's agent replies, oldest first — what heard-note quotes are told apart against. */
function agentReplies(messages: ReadonlyArray<VoiceModeMessage>): HeardReply[] {
  const out: HeardReply[] = [];
  for (const m of messages) {
    if (m.type === "message" && m.role === "assistant" && typeof m.content === "string") {
      out.push({ eventId: m.eventId, text: m.content });
    }
  }
  return out;
}

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };

/** One closed piece of the draft. */
/** pending: being transcribed; done: text (maybe empty) back; failed: lost for good. */
type PieceStatus = "pending" | "done" | "failed";

type TranscribeAttempt = { kind: "text"; text: string } | { kind: "failed" } | { kind: "unreached" } | { kind: "timeout" };

/**
 * The words of an unsent draft, in spoken order, with LOST_PIECE_MARKER where
 * a piece was lost (or never came back). "" when no piece was transcribed.
 */
export function keptDraftText(pieces: ReadonlyArray<{ status: PieceStatus; text: string }>): string {
  const parts: string[] = [];
  let anyWords = false;
  for (const p of pieces) {
    if (p.status === "done") {
      if (p.text) {
        parts.push(p.text);
        anyWords = true;
      }
    } else if (parts[parts.length - 1] !== LOST_PIECE_MARKER) {
      parts.push(LOST_PIECE_MARKER);
    }
  }
  return anyWords ? parts.join(" ").trim() : "";
}

interface Piece {
  id: number;
  status: PieceStatus;
  text: string;
  /** The turn ends after this piece (send it and everything before it). */
  endsTurn?: "timed" | "phrase";
}

/** A live recorder plus the chunks it has produced. */
interface RecorderSlot {
  recorder: MediaRecorder;
  chunks: Blob[];
  /** Per-session sequence number, for matching log lines. */
  id: number;
  startedAt: number;
  /** dataavailable events seen (including empty ones) — drives log throttling. */
  dataEvents: number;
  /** When the last non-empty slice arrived, or null before the first. */
  lastChunkAt: number | null;
}

/** Mic track state for logs: readyState / muted / enabled per audio track. */
function describeTracks(stream: MediaStream | null): string {
  if (!stream) return "tracks=none";
  const t = stream.getAudioTracks();
  if (t.length === 0) return "tracks=0";
  return `tracks=${t.map((x) => `${x.readyState}${x.muted ? "/muted" : ""}${x.enabled ? "" : "/disabled"}`).join(",")}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceMode(args: UseVoiceModeArgs): UseVoiceModeReturn {
  const [phase, setPhaseState] = useState<VoiceModePhase>("off");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  /** A pause froze a reply (or a speak button) mid-sentence: Skip can drop it. */
  const [heldReply, setHeldReply] = useState(false);

  // Latest args, read from async callbacks without re-binding them.
  const argsRef = useRef(args);
  argsRef.current = args;

  const activeRef = useRef(false);
  /** Bumped on every start/teardown so stale async work can tell it's stale. */
  const sessionRef = useRef(0);
  const phaseRef = useRef<VoiceModePhase>("off");
  const streamRef = useRef<MediaStream | null>(null);
  /**
   * The user paused voice mode: mic tracks disabled (silence), no listening,
   * nothing read aloud. Paused time doesn't count toward the timed turn end,
   * so pausing mid-message never sends it.
   */
  const pausedRef = useRef(false);
  /** performance.now() when the current pause began. */
  const pausedAtRef = useRef(0);
  /** What the pause froze, so resume can carry it on. */
  const heldRef = useRef<{ kind: "reading" } | { kind: "button"; owner: symbol } | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const cuesRef = useRef<VoiceModeCues | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const slotRef = useRef<RecorderSlot | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const startedAtRef = useRef(0);
  const queueRef = useRef<QueuedReply[]>([]);
  // Heard note state: the run of what the user lived through this session
  // (replies read to them — voice mode's or a speak button's — and their own
  // messages, in that order), and replies cut off or that couldn't be played
  // and haven't been reported in a sent note yet.
  const runRef = useRef<RunEntry[]>([]);
  const droppedRef = useRef<HeardReply[]>([]);
  /** The reply voice mode is reading now, and whether its audio has begun. */
  const readingRef = useRef<{ reply: HeardReply; began: boolean } | null>(null);
  /** Last speak-button report, kept while off so a button playing at start counts. */
  const lastButtonHeardRef = useRef<{ reply: HeardReply; complete: boolean } | null>(null);
  /**
   * A reply began playing (`complete` false) or played to the end (true). The
   * end of a play updates the step its start made; a new start is a new step
   * — a replay after the user said something lands after it — unless it's
   * the step just before.
   */
  const markHeard = (reply: HeardReply, complete: boolean) => {
    const run = runRef.current;
    let at = run.length - 1;
    // Only an unfinished play reaches back past what the user said since.
    if (complete) while (at >= 0 && run[at].kind !== "heard") at--;
    const prev = run[at];
    const same = prev?.kind === "heard" && sameReply(prev.reply, reply);
    if (same && (at === run.length - 1 || !prev.complete)) {
      run[at] = { kind: "heard", reply, complete: complete || prev.complete };
    } else {
      run.push({ kind: "heard", reply, complete });
    }
    if (run.length > RUN_KEEP) run.splice(0, run.length - RUN_KEEP);
  };
  /** The user sent a message (by voice, or typed while voice mode is on). */
  const markSaid = (text: string) => {
    if (!text.trim()) return;
    runRef.current.push({ kind: "said", text });
    if (runRef.current.length > RUN_KEEP) runRef.current.splice(0, runRef.current.length - RUN_KEEP);
  };
  /**
   * The reply voice mode is reading. `hold` freezes it for a pause: true when
   * it paused mid-sentence; false when no audio had begun, so it went back to
   * the front of the queue (and speaking is over).
   */
  const speakingRef = useRef<{ owner: symbol; finish: () => void; hold: () => boolean } | null>(null);
  const acquiringRef = useRef(false); // getUserMedia in flight
  /** The phone took the audio: the mic was let go, and the play tap takes it back. */
  const micLostRef = useRef(false);
  /** The current pause was made by the phone taking the audio, not by the user. */
  const pausedByPhoneRef = useRef(false);
  /** Set by that tap until real sound arrives — failing again now gets a note. */
  const recoveringRef = useRef(false);
  const interruptRef = useRef<(reason: string, failedRetake?: boolean) => void>(() => {});
  /** Bumped per mic request; a result from an older request is stale. */
  const acquireGenRef = useRef(0);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The current stream has given real (non-zero) sound at least once. */
  const streamHeardRef = useRef(false);
  const requestMicRef = useRef<(kind: MicRequestKind, pending?: Promise<MediaStream>) => void>(() => {});
  const openAudioRef = useRef<() => void>(() => {});
  const clearRecoverTimer = () => {
    if (recoverTimerRef.current !== null) clearTimeout(recoverTimerRef.current);
    recoverTimerRef.current = null;
  };
  /** Any mic request in flight becomes stale (its stream is released on arrival). */
  const cancelMicRequest = () => {
    acquireGenRef.current += 1;
    acquiringRef.current = false;
    clearRecoverTimer();
  };
  const nextRecorderIdRef = useRef(1);

  // Draft state.
  const piecesRef = useRef<Piece[]>([]);
  /** Set while a draft is failing: listening has stopped and pieces still in flight are awaited before bailing. */
  const failingRef = useRef<{ reason: string; what: string; partWhat: string } | null>(null);
  const nextPieceIdRef = useRef(1);
  /** Speech detected in the piece currently being recorded. */
  const pieceSpeechRef = useRef(false);
  /** performance.now() of the last voiced VAD frame (any loud frame). */
  const lastVoiceAtRef = useRef(0);
  /** performance.now() of the last frame of real speech (spans pieces) — timed turn end. */
  const lastSpeechAtRef = useRef(0);
  const yourTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A message was just sent and the agent hasn't picked it up yet. */
  const awaitingReplyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tag = `hostId=${args.hostId} tmuxSession=${args.tmuxSession ?? "null"}`;
  const tagRef = useRef(tag);
  tagRef.current = tag;
  const log = useCallback((msg: string) => console.info(`[voice-mode] ${msg} ${tagRef.current}`), []);

  const playCue = useCallback((cue: VoiceModeCue): boolean => {
    return cuesRef.current?.play(cue) ?? false;
  }, []);

  const setPhase = useCallback((p: VoiceModePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  /** A speak button (not voice mode itself) is loading or playing. */
  const buttonSpeaking = () => {
    const s = getButtonSpeechState();
    return s === "loading" || s === "playing";
  };

  /** The user is mid-turn: speaking now, or holding an unsent draft. */
  const isComposing = () => pieceSpeechRef.current || piecesRef.current.length > 0;
  const turnHasEnded = () => piecesRef.current.some((p) => p.endsTurn !== undefined);

  /** While listening, show where the turn stands. */
  const refreshListeningPhase = () => {
    if (!activeRef.current || vadTimerRef.current === null) return;
    const next: VoiceModePhase = turnHasEnded()
      ? "transcribing"
      : isComposing()
        ? "hearing"
        : "listening";
    if (phaseRef.current !== next) setPhase(next);
  };

  /** Working ticks: turn sending or agent working, nothing playing, user not mid-turn. */
  const updateTickingRef = useRef<() => void>(() => {});
  updateTickingRef.current = () => {
    const cues = cuesRef.current;
    if (!cues) return;
    // From the turn's end (chip: Sending) the ticks run while it transcribes
    // and is sent — unless the user is speaking again.
    const sending = turnHasEnded() && !pieceSpeechRef.current;
    const should =
      activeRef.current &&
      !pausedRef.current &&
      !failingRef.current &&
      (argsRef.current.isWorking || awaitingReplyRef.current !== null || sending) &&
      !argsRef.current.suspended &&
      speakingRef.current === null &&
      !buttonSpeaking() &&
      // Replies that came in while the user talked wait for the send; tick meanwhile.
      (queueRef.current.length === 0 || sending) &&
      (!isComposing() || sending) &&
      streamRef.current !== null;
    if (should && !cues.isTicking()) {
      log("ticking-start");
      cues.startTicking();
    } else if (!should && cues.isTicking()) {
      log("ticking-stop");
      cues.stopTicking();
    }
  };

  const clearAwaitingReply = () => {
    if (awaitingReplyRef.current !== null) clearTimeout(awaitingReplyRef.current);
    awaitingReplyRef.current = null;
  };
  const markAwaitingReply = () => {
    clearAwaitingReply();
    awaitingReplyRef.current = setTimeout(() => {
      awaitingReplyRef.current = null;
      log("awaiting-reply-expired");
      updateTickingRef.current();
    }, AWAIT_REPLY_MAX_MS);
  };

  // ---- Recorder / VAD ----------------------------------------------------

  const stopVad = useCallback(() => {
    if (vadTimerRef.current !== null) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
  }, []);

  /** Stop a recorder; resolve its clip (or null when discarding). */
  const stopSlot = useCallback((slot: RecorderSlot | null, keep: boolean): Promise<Blob | null> => {
    if (!slot) return Promise.resolve(null);
    const { recorder, chunks, id } = slot;
    const ageMs = Math.round(performance.now() - slot.startedAt);
    console.info(
      `[voice-mode] recorder-stop rid=${id} state=${recorder.state} keep=${keep} ageMs=${ageMs} ` +
        `chunks=${chunks.length} ${describeTracks(streamRef.current)} ${tagRef.current}`,
    );
    // Whatever slices arrived are kept — the recorder never delivered the rest.
    const salvage = (via: string): Blob | null => {
      if (!keep || chunks.length === 0) return null;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const lastSliceAgoMs = slot.lastChunkAt === null ? "none" : Math.round(performance.now() - slot.lastChunkAt);
      console.warn(
        `[voice-mode] recorder-onstop-salvaged via=${via} rid=${id} chunks=${chunks.length} bytes=${blob.size} ` +
          `ageMs=${ageMs} lastSliceAgoMs=${lastSliceAgoMs} ${tagRef.current}`,
      );
      return blob;
    };
    // Already stopped by the browser (e.g. an iOS audio interruption).
    if (recorder.state === "inactive") return Promise.resolve(salvage("already-inactive"));
    const stopAt = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = (blob: Blob | null) => {
        if (done) return;
        done = true;
        resolve(blob);
      };
      recorder.onstop = () => {
        const blob = keep ? new Blob(chunks, { type: recorder.mimeType || "audio/webm" }) : null;
        console.info(
          `[voice-mode] recorder-onstop rid=${id} afterMs=${Math.round(performance.now() - stopAt)} ` +
            `chunks=${chunks.length} bytes=${blob?.size ?? "discarded"} ${tagRef.current}`,
        );
        finish(blob);
      };
      // iOS occasionally drops onstop (see useVoiceRecording.stopRecording).
      setTimeout(() => {
        if (!done) {
          console.warn(
            `[voice-mode] recorder-onstop-watchdog rid=${id} state=${recorder.state} chunks=${chunks.length} ` +
              `${describeTracks(streamRef.current)} ctx=${ctxRef.current?.state ?? "none"} ${tagRef.current}`,
          );
          // A stalled recorder may still be emitting slices — stop collecting them.
          recorder.ondataavailable = null;
          finish(salvage("watchdog"));
        }
      }, RECORDER_STOP_WATCHDOG_MS);
      try {
        recorder.stop();
      } catch {
        finish(null);
      }
    });
  }, []);

  const startRecorder = useCallback((): boolean => {
    const stream = streamRef.current;
    if (!stream) return false;
    try {
      const recorder = new MediaRecorder(stream);
      const id = nextRecorderIdRef.current++;
      const slot: RecorderSlot = {
        recorder,
        chunks: [],
        id,
        startedAt: performance.now(),
        dataEvents: 0,
        lastChunkAt: null,
      };
      const tag = () => `rid=${id} ${tagRef.current}`;
      recorder.ondataavailable = (e: BlobEvent) => {
        slot.dataEvents += 1;
        if (e.data && e.data.size > 0) {
          slot.chunks.push(e.data);
          slot.lastChunkAt = performance.now();
        }
        // Slices arrive every RECORDER_TIMESLICE_MS — log only the first and the final one.
        if (slot.dataEvents === 1 || recorder.state !== "recording") {
          console.info(
            `[voice-mode] recorder-data bytes=${e.data?.size ?? 0} state=${recorder.state} ` +
              `chunks=${slot.chunks.length} ${tag()}`,
          );
        }
      };
      recorder.onstart = () => console.info(`[voice-mode] recorder-onstart ${tag()}`);
      recorder.onpause = () => console.warn(`[voice-mode] recorder-onpause ${tag()}`);
      recorder.onresume = () => console.info(`[voice-mode] recorder-onresume ${tag()}`);
      recorder.onerror = (event: Event) => {
        const err = (event as Event & { error?: DOMException }).error;
        console.error(
          `[voice-mode] recorder-onerror errName="${err?.name ?? "unknown"}" errMessage="${err?.message ?? ""}" ` +
            `state=${recorder.state} ${describeTracks(stream)} ${tag()}`,
        );
      };
      recorder.start(RECORDER_TIMESLICE_MS);
      console.info(
        `[voice-mode] recorder-start state=${recorder.state} mime="${recorder.mimeType}" timesliceMs=${RECORDER_TIMESLICE_MS} ` +
          `${describeTracks(stream)} ctx=${ctxRef.current?.state ?? "none"} ${tag()}`,
      );
      slotRef.current = slot;
      return true;
    } catch (err) {
      console.error(`[voice-mode] recorder-start-failed errMessage="${err instanceof Error ? err.message : String(err)}" ${tagRef.current}`);
      return false;
    }
  }, []);

  /**
   * Swap the live recorder for a fresh one; returns the old one's clip and
   * whether the new one started. The old one is stopped first — Safari has
   * had bugs with two recorders on one track, and the user is silent here.
   */
  const rotateRecorder = useCallback(
    (keep: boolean): { clip: Promise<Blob | null>; started: boolean; durationMs: number } => {
      const old = slotRef.current;
      slotRef.current = null;
      const durationMs = old ? performance.now() - old.startedAt : 0;
      const clip = stopSlot(old, keep);
      const started = startRecorder();
      return { clip, started, durationMs };
    },
    [startRecorder, stopSlot],
  );

  // Forward refs so the scheduler / VAD / speaker / pieces can call each other.
  const pumpRef = useRef<() => void>(() => {});
  const closePieceRef = useRef<() => void>(() => {});
  const endTurnRef = useRef<(reason: "timed" | "phrase", piece: Piece) => void>(() => {});
  const bailRef = useRef<(reason: string) => void>(() => {});

  const beginListening = useCallback(() => {
    if (!activeRef.current || !streamRef.current) return;
    const ctx = ctxRef.current;
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    if (!startRecorder()) {
      setErrorMessage("Voice mode: microphone unavailable");
      return;
    }

    const analyser = analyserRef.current;
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;
    let noiseFloor = MIN_SPEECH_RMS / NOISE_MULTIPLIER;
    let voicedMs = 0;
    let speechStartAt = 0;
    let pieceStartAt = performance.now();
    let zeroMs = 0;
    pieceSpeechRef.current = false;

    stopVad();
    vadTimerRef.current = setInterval(() => {
      if (!activeRef.current || !analyser || !buf) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      // A mic that has never given any sound, only exact zeros, is dead (a
      // gated desktop mic going to zero between words had sound first).
      if (sum === 0) {
        zeroMs += VAD_TICK_MS;
        if (!streamHeardRef.current && zeroMs >= DEAD_SOUND_MS) {
          interruptRef.current("dead-sound");
          return;
        }
      } else {
        zeroMs = 0;
        streamHeardRef.current = true;
        recoveringRef.current = false;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const threshold = Math.max(MIN_SPEECH_RMS, noiseFloor * NOISE_MULTIPLIER);

      if (rms > threshold) {
        lastVoiceAtRef.current = now;
        if (pieceSpeechRef.current) lastSpeechAtRef.current = now;
        else {
          voicedMs += VAD_TICK_MS;
          if (voicedMs >= SPEECH_START_MS) {
            pieceSpeechRef.current = true;
            speechStartAt = now;
            lastSpeechAtRef.current = now;
            // Timed mode: talking again before the draft went out means the
            // turn isn't over after all — fold this into the same message.
            const last = piecesRef.current[piecesRef.current.length - 1];
            if (last?.endsTurn === "timed") {
              log(`turn-end-cancelled-by-speech pieceId=${last.id}`);
              last.endsTurn = undefined;
            }
            updateTickingRef.current();
            refreshListeningPhase();
          }
        }
      } else if (!pieceSpeechRef.current) {
        voicedMs = Math.max(0, voicedMs - VAD_TICK_MS / 2);
        // Track ambient noise only while nobody is talking.
        noiseFloor = noiseFloor * 0.97 + rms * 0.03;
      }

      if (pieceSpeechRef.current) {
        const paused = now - lastVoiceAtRef.current >= PIECE_GAP_MS;
        if (paused || now - speechStartAt >= MAX_PIECE_MS) {
          if (!paused) log("piece-max-length");
          pieceSpeechRef.current = false;
          voicedMs = 0;
          pieceStartAt = now;
          closePieceRef.current();
        }
        return;
      }

      // No speech in the current piece. Timed turn end counts from the last
      // real speech, so short noises (keys, a door) can't postpone it.
      const last = piecesRef.current[piecesRef.current.length - 1];
      const settings = getVoiceModeSettings();
      if (
        settings.endOfTurn === "timed" &&
        last !== undefined &&
        last.endsTurn === undefined &&
        now - lastSpeechAtRef.current >= settings.pauseSeconds * 1000
      ) {
        endTurnRef.current("timed", last);
      }
      // Nothing said for a while — drop the clip and start a fresh one (but
      // not while something may be starting, or its first word is lost).
      if (now - pieceStartAt >= IDLE_ROTATE_MS && voicedMs === 0) {
        pieceStartAt = now;
        const { clip, started } = rotateRecorder(false);
        void clip;
        if (!started) bailRef.current("recorder-restart-failed");
      }
    }, VAD_TICK_MS);
    refreshListeningPhase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, rotateRecorder, startRecorder, stopVad]);

  /** Stop listening without keeping what the live recorder captured. */
  const stopListening = useCallback(() => {
    stopVad();
    pieceSpeechRef.current = false;
    const slot = slotRef.current;
    slotRef.current = null;
    void stopSlot(slot, false);
  }, [stopSlot, stopVad]);

  // ---- Transcription -----------------------------------------------------

  /**
   * One attempt, bounded by `timeoutMs`. `text` ("" = no words), `failed` (the
   * server answered that it couldn't transcribe — it already tried both
   * providers), `unreached` (no answer from our server: network error, or a
   * proxy error page while it restarts) or `timeout`. `withHost` lets the
   * server apply its "slash …" command rewrite — only for the first piece of
   * a draft, since that rewrite is anchored at the start of a message.
   */
  const transcribeOnce = useCallback(
    async (blob: Blob, withHost: boolean, durationMs: number, timeoutMs: number): Promise<TranscribeAttempt> => {
      const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "mp4" : blob.type.includes("wav") ? "wav" : "bin";
      const fd = new FormData();
      fd.append("file", blob, `clip.${ext}`);
      fd.append("durationMs", String(Math.round(durationMs)));
      const { hostId, tmuxSession } = argsRef.current;
      if (withHost) {
        fd.append("hostId", String(hostId));
        if (tmuxSession != null) fd.append("tmuxSession", tmuxSession);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<TranscribeAttempt>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[voice-mode] transcribe-timeout timeoutMs=${timeoutMs} ${tagRef.current}`);
          controller.abort();
          resolve({ kind: "timeout" });
        }, timeoutMs);
      });
      const attempt = (async (): Promise<TranscribeAttempt> => {
        try {
          const res = await stampedFetch(TRANSCRIBE_URL, { method: "POST", body: fd, signal: controller.signal });
          if (!res.ok) {
            // Our server always answers with a JSON error; anything else came
            // from in front of it (proxy page while it restarts).
            const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
            const fromServer = body !== null && typeof body === "object" && typeof body.error === "string";
            console.warn(`[voice-mode] transcribe-not-ok status=${res.status} fromServer=${fromServer} ${tagRef.current}`);
            return fromServer ? { kind: "failed" } : { kind: "unreached" };
          }
          const json = (await res.json()) as { text?: string };
          return { kind: "text", text: (json.text ?? "").trim() };
        } catch (err) {
          if (controller.signal.aborted) return { kind: "timeout" };
          console.error(`[voice-mode] transcribe-threw errMessage="${err instanceof Error ? err.message : String(err)}" ${tagRef.current}`);
          return { kind: "unreached" };
        }
      })();
      try {
        return await Promise.race([attempt, timedOut]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
    [],
  );

  /**
   * Wait for the server's answer for up to TRANSCRIBE_WAIT_MS, sending the
   * piece again only when it never reached the server. Resolves the text,
   * null when it finally gave up, or undefined when the session ended first.
   */
  const transcribeWithRetry = useCallback(
    async (blob: Blob, pieceId: number, durationMs: number, withHost: boolean, session: number): Promise<string | null | undefined> => {
      // One clock for the piece: a re-send gets what's left of it, not a fresh wait.
      const deadline = Date.now() + TRANSCRIBE_WAIT_MS;
      let delay = TRANSCRIBE_RESEND_FIRST_DELAY_MS;
      for (let attempt = 1; ; attempt += 1) {
        const result = await transcribeOnce(blob, withHost, durationMs, Math.max(1000, deadline - Date.now()));
        if (sessionRef.current !== session) return undefined;
        if (result.kind === "text") return result.text;
        if (result.kind !== "unreached" || Date.now() + delay > deadline) {
          console.error(`[voice-mode] piece-transcribe-gave-up pieceId=${pieceId} attempts=${attempt} last=${result.kind} ${tagRef.current}`);
          return null;
        }
        log(`piece-transcribe-resend pieceId=${pieceId} attempt=${attempt} delayMs=${delay}`);
        await new Promise((r) => setTimeout(r, delay));
        if (sessionRef.current !== session) return undefined;
        delay = Math.min(delay * 2, TRANSCRIBE_RESEND_MAX_DELAY_MS);
      }
    },
    [log, transcribeOnce],
  );

  // ---- Lifecycle helpers (declared early: pieces + speaker need them) ----

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock && !lock.released) void lock.release().catch(() => {});
  }, []);

  /**
   * Call watch — while paused because the phone took the audio. Logs what
   * the phone reports during and after the call (sound context state, page
   * visible/focused, devices) and nudges the sound context the way coming
   * back to the page does; the phone refuses that while the call holds the
   * audio. Once a context the phone interrupted has run again for a tick
   * (the call is over), voice mode carries on by itself — unless the user
   * paused it themselves.
   */
  const callWatchRef = useRef<{
    timer: ReturnType<typeof setInterval>;
    startedAt: number;
    reason: string;
    lastLine: string;
    lastResume: string;
    sawNotRunning: boolean;
    backAt: number | null;
    detach: () => void;
  } | null>(null);
  const describePage = () =>
    `visible=${typeof document === "undefined" ? "n/a" : document.visibilityState} ` +
    `focus=${typeof document === "undefined" || typeof document.hasFocus !== "function" ? "n/a" : document.hasFocus()}`;

  const stopCallWatch = useCallback(
    (why: string) => {
      const w = callWatchRef.current;
      if (!w) return;
      callWatchRef.current = null;
      clearInterval(w.timer);
      w.detach();
      const now = performance.now();
      log(
        `call-watch-stop why=${why} watchedMs=${Math.round(now - w.startedAt)} ` +
          `contextBackAfterMs=${w.backAt === null ? "never" : Math.round(w.backAt - w.startedAt)} ` +
          `sinceContextBackMs=${w.backAt === null ? "n/a" : Math.round(now - w.backAt)}`,
      );
    },
    [log],
  );

  const callWatchTick = () => {
    const w = callWatchRef.current;
    if (!w) return;
    const now = performance.now();
    if (!activeRef.current || now - w.startedAt >= CALL_WATCH_MAX_MS) {
      stopCallWatch(activeRef.current ? "max-time" : "off");
      return;
    }
    const ctx = ctxRef.current;
    const state = ctx?.state ?? "none";
    const line = `ctx=${state} ${describePage()}`;
    if (line !== w.lastLine) {
      log(`call-watch ${line} atMs=${Math.round(now - w.startedAt)}`);
      w.lastLine = line;
    }
    if (ctx && state !== "running") {
      w.sawNotRunning = true;
      void ctx.resume().then(
        () => {
          const r = `ok state=${ctx.state}`;
          if (callWatchRef.current === w && r !== w.lastResume) log(`call-watch-resume ${r}`);
          w.lastResume = r;
        },
        (err: unknown) => {
          const r = `failed errName=${err instanceof Error ? err.name : "unknown"}`;
          if (callWatchRef.current === w && r !== w.lastResume) log(`call-watch-resume ${r} state=${ctx.state}`);
          w.lastResume = r;
        },
      );
      return;
    }
    // The phone gave the sound back: the call is likely over.
    if (state === "running" && w.sawNotRunning) {
      if (w.backAt === null) {
        w.backAt = now;
        log(`call-watch-context-back afterMs=${Math.round(now - w.startedAt)} ${describePage()}`);
      }
      // One more tick of running before carrying on: the phone may still be
      // moving the audio back (e.g. to earbuds).
      if (now - w.backAt < CALL_WATCH_TICK_MS) return;
      if (!pausedRef.current || !micLostRef.current) {
        stopCallWatch("not-paused");
        return;
      }
      if (!pausedByPhoneRef.current) {
        stopCallWatch("user-paused");
        return;
      }
      stopCallWatch("context-back");
      resumeRef.current("auto");
    }
  };

  const startCallWatch = (reason: string) => {
    if (callWatchRef.current || typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      if (callWatchRef.current) log(`call-watch-event ${e.type} ctx=${ctxRef.current?.state ?? "none"} ${describePage()}`);
    };
    const winEvents = ["focus", "blur", "pageshow", "pagehide"];
    winEvents.forEach((t) => window.addEventListener(t, onEvent));
    document.addEventListener("visibilitychange", onEvent);
    navigator.mediaDevices?.addEventListener?.("devicechange", onEvent);
    callWatchRef.current = {
      timer: setInterval(() => callWatchTickRef.current(), CALL_WATCH_TICK_MS),
      startedAt: performance.now(),
      reason,
      lastLine: "",
      lastResume: "",
      // Interrupted already as the watch starts (the call took the sound).
      sawNotRunning: !!ctxRef.current && ctxRef.current.state !== "running",
      backAt: null,
      detach: () => {
        winEvents.forEach((t) => window.removeEventListener(t, onEvent));
        document.removeEventListener("visibilitychange", onEvent);
        navigator.mediaDevices?.removeEventListener?.("devicechange", onEvent);
      },
    };
    log(`call-watch-start reason=${reason} ctx=${ctxRef.current?.state ?? "none"} ${describePage()}`);
  };
  const callWatchTickRef = useRef(callWatchTick);
  callWatchTickRef.current = callWatchTick;

  /** Tear everything down. `closeAfterMs` lets a final cue finish playing. */
  const teardown = useCallback(
    (closeAfterMs = 0) => {
      stopCallWatch("off");
      activeRef.current = false;
      sessionRef.current += 1;
      queueRef.current = [];
      piecesRef.current = [];
      failingRef.current = null;
      pieceSpeechRef.current = false;
      // A mic request still in flight is released when it arrives.
      acquireGenRef.current += 1;
      acquiringRef.current = false;
      if (recoverTimerRef.current !== null) clearTimeout(recoverTimerRef.current);
      recoverTimerRef.current = null;
      if (yourTurnTimerRef.current !== null) clearTimeout(yourTurnTimerRef.current);
      yourTurnTimerRef.current = null;
      clearAwaitingReply();
      stopVad();
      const slot = slotRef.current;
      slotRef.current = null;
      void stopSlot(slot, false);
      const speaking = speakingRef.current;
      speakingRef.current = null;
      if (speaking && getCurrentOwner() === speaking.owner) {
        getCurrentPlayer()?.stop();
        clearCurrentPlayer();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      analyserRef.current = null;
      const cues = cuesRef.current;
      const ctx = ctxRef.current;
      cuesRef.current = null;
      ctxRef.current = null;
      cues?.stopTicking();
      const close = () => {
        cues?.dispose();
        void ctx?.close().catch(() => {});
      };
      if (closeAfterMs > 0) setTimeout(close, closeAfterMs);
      else close();
      releaseWakeLock();
    },
    [releaseWakeLock, stopCallWatch, stopSlot, stopVad],
  );

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    const dropped = piecesRef.current.length;
    log(`stop draftPiecesDropped=${dropped}`);
    // The off chime goes through the unlocked context (iOS: stop may come from
    // a spoken exit phrase, outside any tap); fall back if there is none.
    if (playCue("off")) {
      teardown(OFF_TAIL_MS);
    } else {
      teardown();
      playAutoSpeakOff();
    }
    setPhase("off");
  }, [log, playCue, teardown, setPhase]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  /**
   * Something went badly wrong mid-turn: off, error cue. Whatever of the
   * draft was transcribed goes into the compose box, unsent, with the gap
   * marked; `partWhat` describes the failure then.
   */
  const bail = useCallback(
    (reason: string, what = "couldn't transcribe what you said", partWhat = "couldn't transcribe part of what you said", cue = true) => {
      if (!activeRef.current) return;
      const kept = keptDraftText(piecesRef.current);
      console.error(`[voice-mode] bail reason=${reason} draftPieces=${piecesRef.current.length} keptLen=${kept.length} ${tagRef.current}`);
      failingRef.current = null;
      if (cue) playCue("error");
      teardown(cue ? ERROR_CUE_TAIL_MS : 0);
      setPhase("off");
      if (kept) {
        const message = `Voice mode stopped: ${partWhat} — the rest is in the compose box, not sent`;
        argsRef.current.onUndelivered(kept, message);
        setErrorMessage(message);
      } else {
        setErrorMessage(`Voice mode stopped: ${what} — nothing was sent`);
      }
    },
    [playCue, teardown, setPhase],
  );

  /**
   * Part of the draft is lost (`piece`, when it's a piece): stop listening and
   * play the error cue now, but let pieces still being transcribed finish —
   * their words are kept too — then bail. Nothing is sent meanwhile.
   */
  const failDraft = (reason: string, what: string, partWhat: string, piece?: Piece) => {
    if (!activeRef.current) return;
    if (piece) piece.status = "failed";
    if (!failingRef.current) {
      failingRef.current = { reason, what, partWhat };
      const pending = piecesRef.current.filter((p) => p.status === "pending").length;
      console.error(`[voice-mode] draft-failing reason=${reason} waitingOnPieces=${pending} ${tagRef.current}`);
      stopListening();
      playCue("error");
      updateTickingRef.current();
    }
    settleFailure();
  };
  /** Bail once every piece of a failing draft has come back. */
  const settleFailure = () => {
    const failing = failingRef.current;
    if (!failing || piecesRef.current.some((p) => p.status === "pending")) return;
    bail(failing.reason, failing.what, failing.partWhat, false);
  };
  bailRef.current = (reason: string) => failDraft(reason, "the microphone stopped recording", "the microphone stopped recording");

  // ---- Pieces + turn end -------------------------------------------------

  /**
   * Send every finished turn whose pieces have all resolved, oldest first. A
   * turn is the pieces up to and including one marked `endsTurn`.
   */
  const tryFinishTurn = () => {
    while (activeRef.current && !failingRef.current) {
      const pieces = piecesRef.current;
      const endIdx = pieces.findIndex((p) => p.endsTurn !== undefined);
      if (endIdx < 0) return;
      const included = pieces.slice(0, endIdx + 1);
      if (included.some((p) => p.status === "pending")) return;
      const reason = included[endIdx].endsTurn;
      piecesRef.current = pieces.slice(endIdx + 1);
      const text = included
        .map((p) => p.text)
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!text) {
        log(`turn-end-empty reason=${reason} pieces=${included.length}`);
        continue;
      }
      setErrorMessage(null);
      const heardNote = currentHeardNote();
      const sent = argsRef.current.send(text, heardNote);
      log(`draft-sent reason=${reason} pieces=${included.length} len=${text.length} dispatched=${sent}`);
      if (sent === "refused") {
        continue;
      }
      if (sent) {
        // Reported now; queued replies stay unheard until they're read.
        droppedRef.current = [];
        markSaid(text);
        markAwaitingReply();
      } else {
        playCue("error");
        argsRef.current.onUndelivered(text);
      }
    }
  };

  /** One of this conversation's agent replies (not another pane's). */
  function isOwnReply(reply: HeardReply): boolean {
    return agentReplies(argsRef.current.messages).some((r) => sameReply(r, reply));
  }

  /** What the user had heard as of now, in words for the agent. */
  function currentHeardNote(): string {
    const reading = readingRef.current;
    const queued = [
      ...(reading && !reading.began ? [reading.reply] : []),
      ...queueRef.current.map((q) => q.reply),
    ];
    log(`heard-note run=${runRef.current.length} queued=${queued.length} missed=${droppedRef.current.length}`);
    return buildHeardNote(
      { run: runRef.current, queued, missed: droppedRef.current },
      agentReplies(argsRef.current.messages),
    );
  }

  endTurnRef.current = (reason, piece) => {
    log(`turn-end reason=${reason} pieceId=${piece.id}`);
    piece.endsTurn = reason;
    // The user can't add to this turn any more: say so now, not once it's
    // transcribed (the ticks follow via pump → updateTicking).
    playCue("sent");
    tryFinishTurn();
    refreshListeningPhase();
    pumpRef.current();
  };

  const onPieceResult = (piece: Piece, text: string | null | undefined, session: number) => {
    // Session over (stopped, or stopped and restarted) — ignore stale pieces.
    if (text === undefined || !activeRef.current || sessionRef.current !== session) return;
    if (text === null) {
      failDraft(`piece-transcribe-failed pieceId=${piece.id}`, "couldn't transcribe what you said", "couldn't transcribe part of what you said", piece);
      return;
    }
    if (failingRef.current) {
      // The draft is already lost in part: just keep these words for the compose box.
      piece.status = "done";
      piece.text = isFillerOnly(text) ? "" : text;
      log(`piece-done-while-failing pieceId=${piece.id} len=${piece.text.length}`);
      settleFailure();
      return;
    }
    if (endsWithExitPhrase(text)) {
      log(`exit-phrase pieceId=${piece.id}`);
      stopRef.current();
      return;
    }
    if (isFillerOnly(text)) {
      log(`piece-filler pieceId=${piece.id} len=${text.length}`);
      text = "";
    }
    piece.status = "done";
    piece.text = text;
    if (!text) {
      // Sneeze, cough, bump: drop it without a trace. (A timed turn end on
      // it moves to the piece before, so earlier words still go.)
      log(`piece-empty pieceId=${piece.id}`);
      const idx = piecesRef.current.indexOf(piece);
      if (piece.endsTurn && idx > 0) {
        const prev = piecesRef.current[idx - 1];
        if (!prev.endsTurn) prev.endsTurn = piece.endsTurn;
      }
      piecesRef.current = piecesRef.current.filter((p) => p !== piece);
    } else {
      log(`piece-done pieceId=${piece.id} len=${text.length}`);
      const settings = getVoiceModeSettings();
      if (settings.endOfTurn === "phrase") {
        const stripped = stripSendPhrase(text, settings.sendPhrase);
        if (stripped !== null) {
          // "Um... over" sends what came before, not the um.
          piece.text = isFillerOnly(stripped) ? "" : stripped;
          endTurnRef.current("phrase", piece);
          return;
        }
      }
    }
    tryFinishTurn();
    refreshListeningPhase();
    pumpRef.current();
  };

  closePieceRef.current = () => {
    const session = sessionRef.current;
    // Only the first piece of a draft gets the server's "slash …" rewrite.
    const withHost = piecesRef.current.length === 0;
    const piece: Piece = { id: nextPieceIdRef.current, status: "pending", text: "" };
    nextPieceIdRef.current += 1;
    piecesRef.current.push(piece);
    refreshListeningPhase();
    const { clip, started, durationMs } = rotateRecorder(true);
    // The mic is gone, but this piece's audio was captured: still transcribe
    // it so its words are kept.
    if (!started) failDraft(`recorder-restart-failed pieceId=${piece.id}`, "the microphone stopped recording", "the microphone stopped recording");
    void (async () => {
      const blob = await clip;
      if (!activeRef.current || sessionRef.current !== session) return;
      log(`piece-closed pieceId=${piece.id} bytes=${blob?.size ?? 0}`);
      // A closed piece always held detected speech — no audio means the
      // recorder lost it, not silence. Never send around the gap.
      if (!blob || blob.size === 0) {
        failDraft(`piece-audio-missing pieceId=${piece.id}`, "the recording of what you said was lost", "the recording of part of what you said was lost", piece);
        return;
      }
      const text = await transcribeWithRetry(blob, piece.id, durationMs, withHost, session);
      onPieceResult(piece, text, session);
    })();
  };

  // ---- Speaking ----------------------------------------------------------

  const speakNext = useCallback(() => {
    const item = queueRef.current.shift();
    if (!item) return;
    const text = item.speakable;
    const reading = { reply: item.reply, began: false };
    readingRef.current = reading;
    const owner = Symbol("voice-mode");
    let finished = false;
    /** Put back at the front of the queue by a pause before any audio. */
    let requeued = false;
    /** Cancels the speech request: a pause before any audio, or the reply ending early (Skip). */
    const request = new AbortController();
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      // Done with this reply however it ended: stop any speech still being
      // made for it (a no-op once the stream has been read to the end).
      request.abort();
      if (watchdog !== null) clearInterval(watchdog);
      if (getCurrentOwner() === owner) clearCurrentPlayer();
      if (speakingRef.current?.owner === owner) speakingRef.current = null;
      if (readingRef.current === reading) readingRef.current = null;
      // Stopped or failed before any audio: never heard.
      if (!reading.began && !requeued && activeRef.current) droppedRef.current.push(reading.reply);
      if (!activeRef.current) return;
      // Reply finished and the agent is done → "your turn" (unless a speak
      // button just took over — its own end plays it — or voice mode is
      // paused: a held reply can still end in an error while paused).
      if (queueRef.current.length === 0 && !argsRef.current.isWorking && !buttonSpeaking() && !pausedRef.current) {
        playCue("yourTurn");
      }
      pumpRef.current();
    };

    const hold = (): boolean => {
      if (reading.began && getCurrentOwner() === owner) {
        void player.pause();
        return true;
      }
      // Nothing heard yet: read it from the start on resume.
      requeued = true;
      queueRef.current.unshift(item);
      request.abort();
      if (getCurrentOwner() === owner) player.stop();
      finish();
      return false;
    };

    speakingRef.current = { owner, finish, hold };
    cuesRef.current?.stopTicking();
    setPhase("speaking");

    // Cross-bubble preempt, same as ChatMessage.startSpeak.
    const prev = getCurrentPlayer();
    if (prev) {
      prev.stop();
      clearCurrentPlayer();
    }
    // Never fail silently: the provider may be down or out of credits, and
    // the server never falls back to another one. Reported once per reply
    // whether the failure hits before audio starts or mid-stream.
    let reported = false;
    const reportFailure = () => {
      if (reported || !activeRef.current) return;
      reported = true;
      playCue("error");
      setErrorMessage("Voice mode: couldn't speak that reply");
    };
    const player = createWebAudioStreamPlayer({
      onCanPlay: () => {
        if (reading.began || getCurrentOwner() !== owner) return;
        reading.began = true;
        markHeard(reading.reply, false);
      },
      onEnded: () => {
        if (reading.began) markHeard(reading.reply, true);
        finish();
      },
      onError: () => {
        reportFailure();
        finish();
      },
    });
    setCurrentPlayer(player);
    setCurrentOwner(owner);
    // External stop() (a bubble speak tap) fires no callback —
    // notice that ownership moved and move on.
    watchdog = setInterval(() => {
      if (getCurrentOwner() !== owner) finish();
    }, 400);

    log(`speak-start textLen=${text.length} voices=[${argsRef.current.voices.join(",")}]`);
    void (async () => {
      try {
        const res = await postSpeakStream(text, argsRef.current.voices, request.signal);
        if (getCurrentOwner() !== owner) {
          void res.body?.cancel().catch(() => {});
          return finish();
        }
        if (!res.ok) throw new Error(`postSpeakStream returned ${res.status}`);
        await player.play(res);
      } catch (err) {
        // Cancelled by a pause (back in the queue) or ended already (Skip):
        // nothing failed.
        if (requeued || finished) return;
        console.error(`[voice-mode] speak-failed errMessage="${err instanceof Error ? err.message : String(err)}" ${tagRef.current}`);
        if (getCurrentOwner() === owner) player.stop();
        reportFailure();
        finish();
      }
    })();
  }, [log, playCue, setPhase]);

  // ---- Scheduler ---------------------------------------------------------

  const acquireStreamRef = useRef<() => void>(() => {});

  pumpRef.current = () => {
    if (!activeRef.current || failingRef.current) return;
    // Paused: nothing listens and nothing new is read; replies wait.
    if (pausedRef.current) {
      if (vadTimerRef.current !== null) stopListening();
      if (phaseRef.current !== "paused") setPhase("paused");
      updateTickingRef.current();
      return;
    }
    if (speakingRef.current) return;
    // Manual mic took over — drop the piece being recorded so the same words
    // aren't captured twice. The draft so far is kept; replies wait.
    if (argsRef.current.suspended) {
      if (vadTimerRef.current !== null) stopListening();
      if (phaseRef.current !== "paused") setPhase("paused");
      updateTickingRef.current();
      return;
    }
    // A speak button is talking: same as reading a reply — not listening, and
    // queued replies wait for it to finish.
    if (buttonSpeaking()) {
      if (vadTimerRef.current !== null) stopListening();
      if (phaseRef.current !== "speaking") setPhase("speaking");
      updateTickingRef.current();
      return;
    }
    // Never talk over the user mid-turn: replies wait until the draft is sent.
    if (queueRef.current.length > 0 && !isComposing()) {
      if (vadTimerRef.current !== null) stopListening();
      speakNext();
      return;
    }
    // Mic track lost (iOS ends a page's older capture when the manual mic
    // opens a new one) — take a fresh stream once the manual mic is done.
    if (!streamRef.current) {
      if (!acquiringRef.current) acquireStreamRef.current();
      return;
    }
    if (vadTimerRef.current === null) beginListening();
    else refreshListeningPhase();
    updateTickingRef.current();
  };

  // ---- Lifecycle ---------------------------------------------------------

  const acquireWakeLock = useCallback(async () => {
    const wl = (navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> };
    }).wakeLock;
    if (!wl || (wakeLockRef.current && !wakeLockRef.current.released)) return;
    try {
      wakeLockRef.current = await wl.request("screen");
      if (!activeRef.current) releaseWakeLock();
    } catch (err) {
      console.warn(`[voice-mode] wake-lock-failed errMessage="${err instanceof Error ? err.message : String(err)}" ${tagRef.current}`);
    }
  }, [releaseWakeLock]);

  const failAcquireRef = useRef<(err: unknown, gen: number, kind: MicRequestKind) => void>(() => {});
  failAcquireRef.current = (err: unknown, gen: number, kind: MicRequestKind) => {
    const stale = gen !== acquireGenRef.current;
    console.error(`[voice-mode] getUserMedia-failed kind=${kind} stale=${stale} errMessage="${err instanceof Error ? err.message : String(err)}" ${tagRef.current}`);
    if (stale) return;
    acquiringRef.current = false;
    clearRecoverTimer();
    if (!activeRef.current) return;
    // Taking the mic back after an interruption: stay paused with the draft kept.
    if (kind === "recover") {
      interruptRef.current("mic-unavailable", true);
      return;
    }
    playCue("error");
    setErrorMessage("Voice mode: microphone unavailable or permission denied");
    teardown(ERROR_CUE_TAIL_MS);
    setPhase("off");
  };

  /** Forget the current stream (and its recorder/VAD) without leaving voice mode. */
  function dropStream() {
    stopListening();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
  }

  const attachStreamRef = useRef<(stream: MediaStream, gen: number) => void>(() => {});
  attachStreamRef.current = (stream: MediaStream, gen: number) => {
    // A request overtaken by an interruption, a pause or a newer request:
    // its mic isn't wanted (the phone may still need it).
    if (gen !== acquireGenRef.current || !activeRef.current) {
      log(`mic-stale-released gen=${gen} current=${acquireGenRef.current}`);
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    acquiringRef.current = false;
    clearRecoverTimer();
    if (streamRef.current && streamRef.current !== stream) dropStream();
    streamRef.current = stream;
    streamHeardRef.current = false;
    console.info(`[voice-mode] stream-attached ${describeMicTrack(stream)} paused=${pausedRef.current} ${tagRef.current}`);
    for (const track of stream.getAudioTracks()) {
      // A stream re-acquired while paused stays silent.
      track.enabled = !pausedRef.current;
      // The phone muting or ending the mic (a call, Siri, another app taking
      // audio) is an interruption: pause, keep everything, let go of the mic.
      // The manual mic taking it over is not — it is re-acquired once released.
      track.onmute = () => {
        console.warn(`[voice-mode] mic-track-muted suspended=${argsRef.current.suspended} ${tagRef.current}`);
        if (!activeRef.current || streamRef.current !== stream || argsRef.current.suspended) return;
        interruptRef.current("mic-muted");
      };
      track.onunmute = () => console.info(`[voice-mode] mic-track-unmuted ${tagRef.current}`);
      track.onended = () => {
        if (!activeRef.current || streamRef.current !== stream) return;
        console.warn(`[voice-mode] mic-track-ended suspended=${argsRef.current.suspended} ${tagRef.current}`);
        if (!argsRef.current.suspended) {
          interruptRef.current("mic-ended");
          return;
        }
        dropStream();
        pumpRef.current();
      };
    }
    const ctx = ctxRef.current;
    if (ctx) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
    }
    void acquireWakeLock();
    // Taken back while the phone still holds it (call not over): a muted mic.
    if (recoveringRef.current && stream.getAudioTracks().some((t) => t.muted)) {
      interruptRef.current("mic-muted");
      return;
    }
    const wasListening = vadTimerRef.current !== null;
    pumpRef.current();
    // Carried on after an interruption: tell the user it's their turn again.
    if (recoveringRef.current && !wasListening && vadTimerRef.current !== null) playCue("yourTurn");
  };

  interruptRef.current = (reason: string, failedRetake = recoveringRef.current) => {
    if (!activeRef.current || failingRef.current) return;
    recoveringRef.current = false;
    log(`interrupted reason=${reason} wasPaused=${pausedRef.current} failedRetake=${failedRetake} ${describeTracks(streamRef.current)}`);
    if (!pausedRef.current) {
      pauseRef.current();
      pausedByPhoneRef.current = true;
    }
    // Let go of the mic while the phone holds it, including one still being
    // asked for; the play tap takes it back.
    cancelMicRequest();
    dropStream();
    micLostRef.current = true;
    startCallWatch(reason);
    // Taking it back didn't work: say so instead of looking like it listens.
    if (failedRetake) {
      setErrorMessage(
        reason === "dead-sound"
          ? "Voice mode paused: the microphone isn't giving any sound"
          : "Voice mode paused: the microphone is still in use",
      );
    }
  };

  /**
   * Ask for the mic. Only the newest request counts: an interruption, a
   * pause during a retake, or a newer request makes older ones stale.
   * "recover" (the play tap after an interruption) gives up after
   * RECOVER_MIC_TIMEOUT_MS — iOS can leave the request hanging mid-call.
   */
  requestMicRef.current = (kind: MicRequestKind, pending?: Promise<MediaStream>) => {
    const gen = ++acquireGenRef.current;
    acquiringRef.current = true;
    clearRecoverTimer();
    log(`mic-request kind=${kind} gen=${gen}`);
    const p =
      pending ??
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    if (kind === "recover") {
      recoverTimerRef.current = setTimeout(() => {
        recoverTimerRef.current = null;
        if (gen !== acquireGenRef.current || !acquiringRef.current) return;
        log(`mic-request-timeout gen=${gen}`);
        interruptRef.current("mic-unavailable", true);
      }, RECOVER_MIC_TIMEOUT_MS);
    }
    p.then(
      (stream) => attachStreamRef.current(stream, gen),
      (err: unknown) => failAcquireRef.current(err, gen, kind),
    );
  };

  /** Re-acquire the mic outside a gesture (permission already granted). */
  acquireStreamRef.current = () => requestMicRef.current("reacquire");

  /** VAD analyser + cue context. Made inside a tap so cues can play with the mic open (iOS). */
  openAudioRef.current = () => {
    try {
      const ctx = new AudioContext();
      void ctx.resume().catch(() => {});
      // iOS moves the context to "interrupted" when the audio session is
      // taken away (call, Siri, media from another app).
      ctx.onstatechange = () => {
        console.info(`[voice-mode] audio-context-state ${ctx.state} ${tagRef.current}`);
        if ((ctx.state as string) === "interrupted" && ctxRef.current === ctx) interruptRef.current("audio-interrupted");
      };
      ctxRef.current = ctx;
      cuesRef.current = createVoiceModeCues(ctx, log);
    } catch {
      ctxRef.current = null;
      cuesRef.current = null;
    }
  };

  const start = useCallback(() => {
    if (activeRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("Voice mode needs microphone access");
      return;
    }
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    activeRef.current = true;
    sessionRef.current += 1;
    piecesRef.current = [];
    failingRef.current = null;
    pieceSpeechRef.current = false;
    pausedRef.current = false;
    heldRef.current = null;
    setHeldReply(false);
    micLostRef.current = false;
    recoveringRef.current = false;
    setPaused(false);
    setErrorMessage(null);
    setPhase("starting");
    const settings = getVoiceModeSettings();
    log(
      `start endOfTurn=${settings.endOfTurn}` +
        (settings.endOfTurn === "timed" ? ` pauseSeconds=${settings.pauseSeconds}` : ""),
    );
    // Created here, inside the start gesture (iOS).
    openAudioRef.current();
    // Only messages that arrive from here on are spoken.
    startedAtRef.current = Date.now();
    seenIdsRef.current = new Set(
      argsRef.current.messages.map((m) => m.eventId).filter((id): id is string => typeof id === "string"),
    );
    queueRef.current = [];
    // A speak button already reading one of this conversation's replies
    // counts as heard from the start.
    const button = lastButtonHeardRef.current;
    runRef.current =
      getButtonSpeechState() === "playing" && button && isOwnReply(button.reply)
        ? [{ kind: "heard", reply: button.reply, complete: button.complete }]
        : [];
    droppedRef.current = [];
    readingRef.current = null;
    playAutoSpeakOn();

    requestMicRef.current("start", streamPromise);
  }, [log, setPhase]);

  const pause = () => {
    // Paused while the play tap is still taking the mic back: drop that
    // request, so the next tap asks again.
    if (recoveringRef.current && acquiringRef.current) {
      cancelMicRequest();
      micLostRef.current = true;
    }
    recoveringRef.current = false;
    pausedByPhoneRef.current = false;
    pausedRef.current = true;
    pausedAtRef.current = performance.now();
    setPaused(true);
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = false;
    // Mid-sentence: keep what was said so far (it's transcribed as a piece).
    const midSpeech = vadTimerRef.current !== null && pieceSpeechRef.current;
    if (midSpeech) closePieceRef.current();
    if (vadTimerRef.current !== null) stopListening();
    const speaking = speakingRef.current;
    let held: string;
    if (speaking) {
      const inPlace = speaking.hold();
      heldRef.current = inPlace ? { kind: "reading" } : null;
      held = inPlace ? "reading" : "reading-requeued";
    } else {
      const owner = pauseButtonSpeech();
      heldRef.current = owner ? { kind: "button", owner } : null;
      held = owner ? "button" : "none";
    }
    setHeldReply(heldRef.current !== null);
    setPhase("paused");
    updateTickingRef.current();
    log(
      `paused held=${held} midSpeech=${midSpeech} draftPieces=${piecesRef.current.length} ` +
        `queued=${queueRef.current.length} ${describeTracks(streamRef.current)}`,
    );
  };

  /** "tap" = the play tap (a user gesture); "auto" = the phone gave the sound back after a call. */
  const resume = (by: "tap" | "auto" = "tap") => {
    pausedRef.current = false;
    pausedByPhoneRef.current = false;
    setPaused(false);
    const pausedMs = performance.now() - pausedAtRef.current;
    // The timed turn end picks up where it was when the pause began.
    lastSpeechAtRef.current += pausedMs;
    for (const track of streamRef.current?.getAudioTracks() ?? []) track.enabled = true;
    // After an interruption: take the mic (and, from a tap, the sound) back.
    if (micLostRef.current) {
      stopCallWatch(by === "tap" ? "play" : "auto");
      micLostRef.current = false;
      recoveringRef.current = true;
      setErrorMessage(null);
      dropStream();
      // From a tap, a fresh sound context too: the old one may be what the
      // phone broke (starting voice mode afresh is what was seen to fix it).
      // Carrying on by itself, the old one is already running again — and a
      // new one made outside a tap would start suspended.
      if (by === "tap") {
        const oldCues = cuesRef.current;
        const oldCtx = ctxRef.current;
        oldCues?.stopTicking();
        oldCues?.dispose();
        void oldCtx?.close().catch(() => {});
        openAudioRef.current();
      }
      requestMicRef.current("recover");
    }
    const held = heldRef.current;
    heldRef.current = null;
    setHeldReply(false);
    let carried = "none";
    if (held?.kind === "reading" && speakingRef.current && getCurrentOwner() === speakingRef.current.owner) {
      void getCurrentPlayer()?.resume();
      setPhase("speaking");
      carried = "reading";
    } else if (held?.kind === "button" && resumeButtonSpeech(held.owner)) {
      carried = "button"; // the button's state change re-runs the pump
    }
    log(`resumed by=${by} carried=${carried} pausedMs=${Math.round(pausedMs)} queued=${queueRef.current.length}`);
    if (carried !== "none") return;
    const wasListening = vadTimerRef.current !== null;
    pumpRef.current();
    // Back to listening: tell the user it's their turn again.
    if (!wasListening && vadTimerRef.current !== null) playCue("yourTurn");
  };

  // Latest pause/resume (they're remade every render), for the stable toggle.
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const togglePause = useCallback(() => {
    if (!activeRef.current) return;
    if (pausedRef.current) resumeRef.current();
    else pauseRef.current();
  }, []);

  // New assistant messages → speech queue.
  useEffect(() => {
    if (!activeRef.current) return;
    const seen = seenIdsRef.current;
    let added = false;
    for (const m of args.messages) {
      if (typeof m.eventId !== "string" || seen.has(m.eventId)) continue;
      seen.add(m.eventId);
      if (m.type !== "message" || typeof m.content !== "string") continue;
      if (typeof m.ts === "number" && m.ts < startedAtRef.current - HISTORY_SLACK_MS) continue;
      // A typed message joins the heard run; voice mode's own sends already did.
      if (m.role === "user") {
        if (stripVoiceLabel(m.content) === m.content && !NOT_TYPED_RE.test(m.content)) markSaid(m.content);
        continue;
      }
      if (m.role !== "assistant") continue;
      const text = toSpeakableText(m.content);
      if (text) {
        queueRef.current.push({ reply: { eventId: m.eventId, text: m.content }, speakable: text });
        added = true;
        clearAwaitingReply();
      }
    }
    if (added) pumpRef.current();
  }, [args.messages]);

  // A speak button started, paused, resumed or finished → re-evaluate. When it
  // finishes (not paused, not preempted by a reply) it's the user's turn.
  useEffect(() => {
    let was = buttonSpeaking();
    return subscribeSpeech(() => {
      const now = buttonSpeaking();
      if (now === was) return;
      was = now;
      // A new button play: what an earlier one read is no longer current.
      if (now) lastButtonHeardRef.current = null;
      if (!activeRef.current) return;
      const state = getButtonSpeechState();
      log(`button-speech ${now ? "start" : state === "paused" ? "paused" : "end"}`);
      // A tapped bubble cut off the reply being read — move on now rather
      // than waiting for the reply's ownership watchdog.
      if (now && speakingRef.current) {
        speakingRef.current.finish();
        return;
      }
      if (
        !now &&
        state === null &&
        speakingRef.current === null &&
        queueRef.current.length === 0 &&
        !argsRef.current.isWorking &&
        !argsRef.current.suspended &&
        !pausedRef.current &&
        !isComposing()
      ) {
        playCue("yourTurn");
      }
      pumpRef.current();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A speak button read (part of) an agent reply → that's what was last heard.
  useEffect(
    () =>
      subscribeHeard((r) => {
        const reply: HeardReply = { eventId: r.eventId, text: r.text };
        // Speak buttons in other panes (other conversations) are not ours.
        if (!isOwnReply(reply)) return;
        const next = { reply, complete: r.outcome === "finished" };
        lastButtonHeardRef.current = next;
        if (!activeRef.current) return;
        markHeard(reply, next.complete);
        // Heard after all — no longer "not heard".
        droppedRef.current = droppedRef.current.filter((d) => !sameReply(d, reply));
      }),
    [],
  );

  // Manual mic in use → pause; released → resume.
  useEffect(() => {
    // Don't play a reply into the user's dictation: cut the current one short
    // (queued replies wait until the manual mic is released).
    const speaking = speakingRef.current;
    if (args.suspended && speaking) {
      log("speech-cut-by-manual-mic");
      if (getCurrentOwner() === speaking.owner) getCurrentPlayer()?.stop();
      speaking.finish();
    }
    if (!args.suspended && activeRef.current && streamRef.current) {
      const dead = streamRef.current
        .getAudioTracks()
        .some((t) => t.readyState === "ended" || t.muted);
      if (dead) {
        log("mic-track-dead-after-manual-mic");
        dropStream();
      }
    }
    pumpRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.suspended]);

  // Agent working/finished → ticking follows it; finished while idle → "your turn".
  const prevWorkingRef = useRef(args.isWorking);
  useEffect(() => {
    const was = prevWorkingRef.current;
    prevWorkingRef.current = args.isWorking;
    // The agent picked the message up — its own working signal takes over.
    if (args.isWorking) clearAwaitingReply();
    updateTickingRef.current();
    if (yourTurnTimerRef.current !== null) {
      clearTimeout(yourTurnTimerRef.current);
      yourTurnTimerRef.current = null;
    }
    if (!activeRef.current || !was || args.isWorking) return;
    // The final reply can land just after the agent goes idle; wait a beat so
    // "your turn" isn't played here AND again when that reply finishes.
    yourTurnTimerRef.current = setTimeout(() => {
      yourTurnTimerRef.current = null;
      if (
        activeRef.current &&
        !argsRef.current.isWorking &&
        speakingRef.current === null &&
        queueRef.current.length === 0 &&
        !isComposing() &&
        phaseRef.current === "listening"
      ) {
        playCue("yourTurn");
      }
    }, YOUR_TURN_SETTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.isWorking]);

  // Coming back to the foreground: re-take the wake lock (the browser drops it
  // when hidden) and wake the analyser's AudioContext.
  useEffect(() => {
    const onVisibility = () => {
      if (activeRef.current) log(`page-visibility ${document.visibilityState} ctx=${ctxRef.current?.state ?? "none"}`);
      if (!activeRef.current || document.visibilityState !== "visible") return;
      void acquireWakeLock();
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [acquireWakeLock, log]);

  // A visible Skip button (the voice-mode pill) — never a tap on the status.
  // Skips only what is being read; replies waiting behind it still play.
  // While paused it drops the frozen reply: voice mode stays paused.
  const skipSpeech = useCallback(() => {
    const held = heldRef.current;
    heldRef.current = null;
    setHeldReply(false);
    if (held?.kind === "button" && getCurrentOwner() === held.owner) {
      log("skip-held-button-speech");
      getCurrentPlayer()?.stop();
      clearCurrentPlayer();
    }
    if (buttonSpeaking()) {
      log("skip-button-speech");
      getCurrentPlayer()?.stop();
      clearCurrentPlayer(); // the button hears this and goes idle; we pump
    }
    const speaking = speakingRef.current;
    if (speaking) log(`skip-reply queued=${queueRef.current.length}`);
    if (speaking && getCurrentOwner() === speaking.owner) getCurrentPlayer()?.stop();
    speaking?.finish();
  }, [log]);

  const levelBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const readLevel = useCallback((): number | null => {
    if (!activeRef.current) return null;
    if (pausedRef.current) return 0;
    if (phaseRef.current === "speaking") return getCurrentPlayer()?.readLevel?.() ?? null;
    const analyser = analyserRef.current;
    const ctx = ctxRef.current;
    if (!analyser || !ctx || ctx.state !== "running") return null;
    if (levelBufRef.current?.length !== analyser.fftSize) levelBufRef.current = new Float32Array(analyser.fftSize);
    const buf = levelBufRef.current;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }, []);

  // App-wide flag: while on, every other mic / voice-mode button is disabled.
  const isOn = phase !== "off";
  useEffect(() => {
    if (!isOn) return;
    return registerVoiceModeActive(Symbol("voice-mode"));
  }, [isOn]);

  // Unmount → release the mic, player and wake lock.
  useEffect(
    () => () => {
      teardown();
    },
    [teardown],
  );

  return { active: phase !== "off", phase, errorMessage, start, stop, paused: paused && phase !== "off", togglePause, skipSpeech, canSkip: phase === "speaking" || (paused && heldReply), readLevel };
}
