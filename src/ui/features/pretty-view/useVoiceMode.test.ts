// Unit tests for useVoiceMode — the hands-free voice-mode loop behind the
// ComposeBox voice-mode button. The browser audio stack (getUserMedia,
// MediaRecorder, AudioContext/AnalyserNode), the STT fetch, the TTS fetch, the
// stream player and the cue module are all stubbed; the analyser's RMS level
// is driven by the test (`setLevel`) so VAD transitions can be walked with
// fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const stampedFetch = vi.fn();
vi.mock("@/lib/stamped-fetch", () => ({ stampedFetch: (...a: unknown[]) => stampedFetch(...a) }));

const postSpeakStream = vi.fn();
// The abort signal (third argument) is recorded separately so assertions stay on text + voices.
const speakSignals: Array<AbortSignal | undefined> = [];
vi.mock("../../api/voice-api", () => ({
  postSpeakStream: (text: unknown, voices: unknown, signal?: AbortSignal) => {
    speakSignals.push(signal);
    return postSpeakStream(text, voices);
  },
}));

vi.mock("../../audio/auto-speak-cue", () => ({ playAutoSpeakOn: vi.fn(), playAutoSpeakOff: vi.fn() }));

type PlayerOpts = { onEnded?: () => void; onError?: (e: Error) => void; onCanPlay?: () => void };
const players: Array<{
  opts: PlayerOpts;
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  readLevel: ReturnType<typeof vi.fn>;
}> = [];
vi.mock("./webAudioStreamPlayer", () => ({
  createWebAudioStreamPlayer: (opts: PlayerOpts) => {
    const p = { opts, play: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), readLevel: vi.fn(() => 0.25) };
    players.push(p);
    return p;
  },
}));

// Cue module: record every cue and the ticking state.
const cuesPlayed: string[] = [];
let ticking = false;
vi.mock("./voice-mode-cues", () => ({
  createVoiceModeCues: () => ({
    play: (cue: string) => {
      cuesPlayed.push(cue);
      return true;
    },
    startTicking: () => {
      ticking = true;
    },
    stopTicking: () => {
      ticking = false;
    },
    isTicking: () => ticking,
    dispose: () => {
      ticking = false;
    },
  }),
}));

import {
  useVoiceMode,
  endsWithExitPhrase,
  isFillerOnly,
  stripSendPhrase,
  toSpeakableText,
  PIECE_GAP_MS,
  RECORDER_TIMESLICE_MS,
  TIMED_END_MS,
  TRANSCRIBE_WAIT_MS,
  LOST_PIECE_MARKER,
  keptDraftText,
  AWAIT_REPLY_MAX_MS,
  DEAD_SOUND_MS,
  RECOVER_MIC_TIMEOUT_MS,
  CALL_WATCH_TICK_MS,
  type UseVoiceModeArgs,
  type VoiceModeMessage,
} from "./useVoiceMode";
import {
  clearCurrentPlayer,
  getCurrentOwner,
  getCurrentPlayer,
  setButtonControls,
  setButtonSpeechState,
  setCurrentOwner,
  setCurrentPlayer,
  takeOverForButton,
  reportHeard,
  type ButtonSpeechState,
} from "./speak-singleton";
import { setVoiceModeSettings } from "./voice-mode-settings";
import { appendVoiceLabel } from "./voice-label";

// ---------------------------------------------------------------------------
// Browser audio stubs
// ---------------------------------------------------------------------------

let level = 0;
function setLevel(v: number) {
  level = v;
}
/** The phone passing exact zeros instead of mic sound. */
let deadSound = false;
/** A real mic is never exactly silent: "silence" carries a faint hiss. */
const HISS = 1e-4;

class MockAnalyser {
  fftSize = 1024;
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(deadSound ? 0 : level || HISS);
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  constructor() {
    MockAudioContext.instances.push(this);
  }
  state = "running";
  onstatechange: (() => void) | null = null;
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createAnalyser() {
    return new MockAnalyser();
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  mimeType = "audio/webm";
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) {
    MockMediaRecorder.instances.push(this);
  }
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  });
}

type MockTrack = {
  stop: ReturnType<typeof vi.fn>;
  onended: null | (() => void);
  onmute?: null | (() => void);
  enabled: boolean;
  muted?: boolean;
};
const track: MockTrack = { stop: vi.fn(), onended: null, onmute: null, enabled: true, muted: false };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const getUserMedia = vi.fn();
const wakeLockRelease = vi.fn().mockResolvedValue(undefined);
const wakeLockRequest = vi.fn();

function transcribeReturns(text: string) {
  stampedFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ text }) });
}

/** A transcription the test resolves by hand (to reorder pieces). */
function transcribeDeferred(): (text: string) => void {
  let resolve!: (v: unknown) => void;
  stampedFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  return (text: string) => resolve({ ok: true, status: 200, json: async () => ({ text }) });
}

function baseArgs(overrides: Partial<UseVoiceModeArgs> = {}): UseVoiceModeArgs {
  return {
    hostId: 1,
    tmuxSession: "s1",
    voices: ["Ruth"],
    isWorking: false,
    messages: [],
    suspended: false,
    send: vi.fn(() => true),
    onUndelivered: vi.fn(),
    ...overrides,
  };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Speak for `speechMs`, then pause just long enough to close the piece. */
async function sayPiece(speechMs = 600) {
  setLevel(0.2);
  await flush(speechMs);
  setLevel(0);
  await flush(PIECE_GAP_MS + 100);
}

/** Speak, then stay silent long enough for timed mode to send. */
async function sayUtterance(speechMs = 600) {
  await sayPiece(speechMs);
  await flush(TIMED_END_MS);
}

async function startVoiceMode(args: UseVoiceModeArgs = baseArgs()) {
  const hook = renderHook((p: UseVoiceModeArgs) => useVoiceMode(p), { initialProps: args });
  act(() => hook.result.current.start());
  await flush();
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  level = 0;
  deadSound = false;
  MockAudioContext.instances = [];
  track.muted = false;
  players.length = 0;
  speakSignals.length = 0;
  cuesPlayed.length = 0;
  ticking = false;
  MockMediaRecorder.instances = [];
  stampedFetch.mockReset();
  postSpeakStream.mockReset();
  postSpeakStream.mockResolvedValue({ ok: true, status: 200 });
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue(stream);
  track.enabled = true;
  wakeLockRequest.mockReset();
  wakeLockRequest.mockResolvedValue({ release: wakeLockRelease, released: false });
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: wakeLockRequest },
  });
  setVoiceModeSettings({ endOfTurn: null, sendPhrase: null });
  clearCurrentPlayer();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("endsWithExitPhrase", () => {
  it.each([
    "Stop voice mode.",
    "exit voice mode",
    "Turn off voice mode please",
    "end the voice mode!",
    "OK, that's all for now. Stop voice mode.",
  ])("matches %s", (t) => expect(endsWithExitPhrase(t)).toBe(true));
  it.each(["stop", "stop voice mode and then run the tests", "voice mode is great", "backstop voice mode"])(
    "ignores %s",
    (t) => expect(endsWithExitPhrase(t)).toBe(false),
  );
});

describe("stripSendPhrase", () => {
  it.each([
    ["Run the tests. Send it.", "send it", "Run the tests."],
    ["run the tests, send it", "send it", "run the tests"],
    ["Send it!", "send it", ""],
    ["Deploy when green — over and out", "Over and out", "Deploy when green"],
    ["SEND IT", "send it", ""],
  ])("strips %j with phrase %j", (text, phrase, expected) => {
    expect(stripSendPhrase(text, phrase)).toBe(expected);
  });
  it.each([
    ["send it to the team", "send it"],
    ["just send", "send it"],
    ["resend it", "send it"],
    ["anything", "  "],
  ])("returns null for %j / %j", (text, phrase) => {
    expect(stripSendPhrase(text, phrase)).toBeNull();
  });
});

describe("isFillerOnly", () => {
  it.each(["Um...", " Um, um,", "Uh.", "Uhh", "Er", "Erm,", "Ah!", "Oh.", "Hmm?", "hm", "Mm.", "Mmm", "Mhm.", "Mm-hmm.", "Uh-huh.", "Uh-uh", "Um. Uh, hmm."])(
    "drops %j",
    (t) => expect(isFillerOnly(t)).toBe(true),
  );
  it.each(["", "  ", "...", "Yes.", "No", "Um, yes.", "Oh no", "hmm, let me think", "Huh?", "Okay.", "Thank you.", "um 2"])(
    "keeps %j",
    (t) => expect(isFillerOnly(t)).toBe(false),
  );
});

describe("toSpeakableText", () => {
  it("drops markdown formatting and announces code blocks", () => {
    const md = "## Result\n\n**Done** — see [the PR](https://x.y/1).\n\n```ts\nconst a = 1;\n```\n- item `one`";
    const out = toSpeakableText(md);
    expect(out).toContain("Result");
    expect(out).toContain("Done — see the PR.");
    expect(out).toContain("(code block omitted)");
    expect(out).toContain("item one");
    expect(out).not.toMatch(/[#*`]/);
    expect(out).not.toContain("const a");
  });
});

// ---------------------------------------------------------------------------
// Hook behaviour
// ---------------------------------------------------------------------------

describe("useVoiceMode", () => {
  it("calls getUserMedia synchronously in start(), takes a wake lock and starts listening", async () => {
    const { result } = renderHook((p: UseVoiceModeArgs) => useVoiceMode(p), { initialProps: baseArgs() });
    act(() => result.current.start());
    // D-16-02: no await between start() and getUserMedia.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("starting");
    await flush();
    expect(result.current.phase).toBe("listening");
    expect(result.current.active).toBe(true);
    expect(wakeLockRequest).toHaveBeenCalledWith("screen");
    expect(MockMediaRecorder.instances[0].start).toHaveBeenCalled();
  });

  describe("timed mode (default)", () => {
    it("transcribes a piece at a short pause but only sends after the longer silence", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("run the tests please");
      setLevel(0.2);
      await flush(400);
      expect(result.current.phase).toBe("hearing");
      setLevel(0);
      await flush(PIECE_GAP_MS + 100);
      // The piece is transcribed, and the next recorder is already running.
      expect(stampedFetch).toHaveBeenCalledWith("/voice/transcribe", expect.objectContaining({ method: "POST" }));
      expect(MockMediaRecorder.instances.length).toBe(2);
      expect(send).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("hearing");
      await flush(TIMED_END_MS);
      expect(send).toHaveBeenCalledWith("run the tests please", expect.any(String));
      expect(cuesPlayed).toEqual(["sent"]);
      expect(result.current.phase).toBe("listening");
    });

    it("can pause between pieces without sending, and sends them as one message in spoken order", async () => {
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      const first = transcribeDeferred();
      const second = transcribeDeferred();
      await sayPiece();
      // A thinking pause longer than a piece gap but shorter than the turn end.
      await flush(500);
      await sayPiece();
      // Results come back out of order.
      second("and then deploy it.");
      await flush();
      first("Run the tests,");
      await flush(TIMED_END_MS);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("Run the tests, and then deploy it.", expect.any(String));
    });

    it("drops a piece with no words (sneeze) without a sound, a send, or a stage change", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("");
      await sayUtterance();
      expect(stampedFetch).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(cuesPlayed).toEqual([]);
      expect(result.current.phase).toBe("listening");
    });

    it("drops a piece that is only filler sounds (noise written as 'Um...') like an empty one", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns(" Um...");
      await sayUtterance();
      await flush(TIMED_END_MS * 2);
      expect(send).not.toHaveBeenCalled();
      expect(cuesPlayed).toEqual([]);
      expect(result.current.phase).toBe("listening");
    });

    it("ignores short bumps that never reach the speech-start threshold", async () => {
      const { result } = await startVoiceMode();
      setLevel(0.2);
      await flush(100);
      setLevel(0);
      await flush(TIMED_END_MS * 2);
      expect(stampedFetch).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("listening");
    });

    it("never cuts off long talking — a piece only closes at a pause", async () => {
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("a very long thought");
      setLevel(0.2);
      await flush(6 * 60 * 1000); // past the old five-minute cap
      // The safety cap closed one piece mid-speech; the next piece keeps recording.
      expect(stampedFetch).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      transcribeReturns("that finally ends");
      setLevel(0);
      await flush(PIECE_GAP_MS + TIMED_END_MS + 200);
      expect(send).toHaveBeenCalledWith("a very long thought that finally ends", expect.any(String));
    });
  });

  describe("pause length", () => {
    it("ends the turn after the user's chosen silence, not the default", async () => {
      setVoiceModeSettings({ endOfTurn: "timed", pauseSeconds: 8 });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("take your time with this one");
      await sayPiece();
      await flush(TIMED_END_MS + 1000);
      expect(send).not.toHaveBeenCalled();
      await flush(8000 - TIMED_END_MS);
      expect(send).toHaveBeenCalledWith("take your time with this one", expect.any(String));
    });

    it("picks up a change to the pause mid-session", async () => {
      setVoiceModeSettings({ endOfTurn: "timed", pauseSeconds: 20 });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("quicker now");
      await sayPiece();
      await flush(1000);
      setVoiceModeSettings({ endOfTurn: "timed", pauseSeconds: 2 });
      await flush(1000);
      expect(send).toHaveBeenCalledWith("quicker now", expect.any(String));
    });

    it("never goes below 2 seconds even if handed a smaller number", async () => {
      setVoiceModeSettings({ endOfTurn: "timed", pauseSeconds: 0 });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("not too fast");
      setLevel(0.2);
      await flush(600);
      setLevel(0);
      await flush(1900);
      expect(send).not.toHaveBeenCalled();
      await flush(300);
      expect(send).toHaveBeenCalledWith("not too fast", expect.any(String));
    });
  });

  describe("send-phrase mode", () => {
    beforeEach(() => setVoiceModeSettings({ endOfTurn: "phrase", sendPhrase: "send it" }));

    it("never sends on silence; sends the draft when a piece ends with the phrase (phrase removed)", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("First, check the logs.");
      await sayPiece();
      await flush(2 * 60 * 1000); // a long think
      expect(send).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("hearing");
      transcribeReturns("Then fix it. Send it.");
      await sayPiece();
      expect(send).toHaveBeenCalledWith("First, check the logs. Then fix it.", expect.any(String));
      expect(cuesPlayed).toEqual(["sent"]);
      expect(result.current.phase).toBe("listening");
    });

    it("defaults to the phrase 'over'", async () => {
      setVoiceModeSettings({ endOfTurn: "phrase" });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("ship the fix. Send it.");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      transcribeReturns("Over.");
      await sayPiece();
      expect(send).toHaveBeenCalledWith("ship the fix. Send it.", expect.any(String));
    });

    it("uses a custom phrase from the preference", async () => {
      setVoiceModeSettings({ endOfTurn: "phrase", sendPhrase: "over and out" });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("ship the fix. Send it.");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      transcribeReturns("Over and out.");
      await sayPiece();
      expect(send).toHaveBeenCalledWith("ship the fix. Send it.", expect.any(String));
    });

    it("waits for earlier pieces before sending", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      const first = transcribeDeferred();
      await sayPiece();
      transcribeReturns("send it");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("transcribing");
      first("look at the failing test");
      await flush();
      expect(send).toHaveBeenCalledWith("look at the failing test", expect.any(String));
    });

    it("goes back to listening after a filler-only piece, and reads the next reply", async () => {
      const send = vi.fn(() => true);
      const { result, rerender } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("Um, um,");
      await sayPiece();
      expect(result.current.phase).toBe("listening");
      rerender(baseArgs({
        send,
        messages: [{ type: "message", role: "assistant", content: "next reply", eventId: "a1", ts: Date.now() }],
      }));
      await flush(1000);
      expect(postSpeakStream).toHaveBeenCalledWith("next reply", ["Ruth"]);
      expect(send).not.toHaveBeenCalled();
    });

    it("drops filler before the send phrase but still sends the earlier words", async () => {
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("check the logs");
      await sayPiece();
      transcribeReturns("Um... send it.");
      await sayPiece();
      expect(send).toHaveBeenCalledWith("check the logs", expect.any(String));
    });

    it("sends nothing when the whole turn is filler plus the send phrase", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("Mm-hmm. Send it.");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("listening");
    });

    it("holds replies (and the working ticks) while a draft is unsent", async () => {
      const send = vi.fn(() => true);
      const { result, rerender } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("hmm, let me think");
      await sayPiece();
      rerender(baseArgs({
        send,
        isWorking: true,
        messages: [{ type: "message", role: "assistant", content: "earlier reply", eventId: "a1", ts: Date.now() }],
      }));
      await flush(10_000);
      expect(postSpeakStream).not.toHaveBeenCalled();
      expect(ticking).toBe(false);
      expect(result.current.phase).toBe("hearing");
      transcribeReturns("okay. send it");
      await sayPiece();
      expect(send).toHaveBeenCalledWith("hmm, let me think okay.", expect.any(String));
      expect(postSpeakStream).toHaveBeenCalledWith("earlier reply", ["Ruth"]);
    });
  });

  describe("leaving and failing", () => {
    it("leaves voice mode on an exit phrase at the end of a piece and throws the draft away", async () => {
      const send = vi.fn(() => true);
      const onUndelivered = vi.fn();
      setVoiceModeSettings({ endOfTurn: "phrase" });
      const { result } = await startVoiceMode(baseArgs({ send, onUndelivered }));
      transcribeReturns("delete the old branch");
      await sayPiece();
      transcribeReturns("actually never mind. Stop voice mode.");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      expect(onUndelivered).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("off");
      expect(cuesPlayed).toEqual(["off"]);
      expect(track.stop).toHaveBeenCalled();
      expect(wakeLockRelease).toHaveBeenCalled();
    });

    it("sends a piece again when it never reached the server, and carries on when it succeeds", async () => {
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      // A proxy error page (no JSON error from our server) while it restarts.
      stampedFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
      transcribeReturns("retry worked");
      await sayPiece();
      await flush(TIMED_END_MS + 2000);
      expect(stampedFetch).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith("retry worked", expect.any(String));
      expect(cuesPlayed).not.toContain("error");
    });

    it("waits for a slow server answer instead of giving up (2026-11-18: answer at 67 s)", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("first five minutes");
      await sayPiece();
      const answer = transcribeDeferred();
      await sayUtterance();
      await flush(67_000);
      expect(result.current.phase).not.toBe("off");
      answer("the rest of it");
      await flush();
      expect(send).toHaveBeenCalledWith("first five minutes the rest of it", expect.any(String));
      expect(stampedFetch).toHaveBeenCalledTimes(2);
      expect(cuesPlayed).not.toContain("error");
    });

    it("the server saying it couldn't transcribe is final: no re-send, and what was transcribed goes to the compose box", async () => {
      const send = vi.fn(() => true);
      const onUndelivered = vi.fn();
      const { result } = await startVoiceMode(baseArgs({ send, onUndelivered }));
      transcribeReturns("first half of the instructions");
      await sayPiece();
      stampedFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: "STT error", status: 502 }) });
      await sayPiece();
      await flush();
      expect(stampedFetch).toHaveBeenCalledTimes(2);
      expect(send).not.toHaveBeenCalled();
      const message = "Voice mode stopped: couldn't transcribe part of what you said — the rest is in the compose box, not sent";
      expect(onUndelivered).toHaveBeenCalledWith(`first half of the instructions ${LOST_PIECE_MARKER}`, message);
      expect(cuesPlayed).toContain("error");
      expect(result.current.phase).toBe("off");
      expect(result.current.errorMessage).toBe(message);
    });

    it("bails with nothing kept when no piece was transcribed", async () => {
      const send = vi.fn(() => true);
      const onUndelivered = vi.fn();
      const { result } = await startVoiceMode(baseArgs({ send, onUndelivered }));
      stampedFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "voice STT unavailable" }) });
      await sayPiece();
      await flush();
      expect(onUndelivered).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("off");
      expect(result.current.errorMessage).toMatch(/couldn't transcribe what you said — nothing was sent/);
    });

    it("hands an unsendable draft to onUndelivered so it is never lost", async () => {
      const onUndelivered = vi.fn();
      const { result } = await startVoiceMode(baseArgs({ send: () => false, onUndelivered }));
      transcribeReturns("hello there");
      await sayUtterance();
      expect(onUndelivered).toHaveBeenCalledWith("hello there");
      // The send cue marks the turn's end; the error cue that it didn't go.
      expect(cuesPlayed).toEqual(["sent", "error"]);
      expect(result.current.phase).toBe("listening");
    });
  });

  describe("replies and sounds", () => {
    it("Skip stops only the reply being read; the next waiting reply plays, then voice mode listens again", async () => {
      const { result, rerender } = await startVoiceMode();
      const next: VoiceModeMessage[] = [
        { type: "message", role: "assistant", content: "first reply", eventId: "s1", ts: Date.now() },
        { type: "message", role: "assistant", content: "second reply", eventId: "s2", ts: Date.now() },
      ];
      rerender(baseArgs({ messages: next }));
      await flush();
      expect(result.current.phase).toBe("speaking");
      expect(postSpeakStream).toHaveBeenCalledTimes(1);

      const firstSignal = speakSignals[speakSignals.length - 1];
      act(() => result.current.skipSpeech());
      await flush();
      expect(players[0].stop).toHaveBeenCalled();
      // The skipped reply's speech request is cancelled, with no error shown.
      expect(firstSignal?.aborted).toBe(true);
      expect(result.current.errorMessage).toBeNull();
      // The waiting second reply is read next.
      expect(postSpeakStream).toHaveBeenCalledTimes(2);
      expect(postSpeakStream).toHaveBeenLastCalledWith("second reply", ["Ruth"]);
      expect(result.current.phase).toBe("speaking");

      act(() => players[1].opts.onEnded?.());
      await flush();
      expect(result.current.phase).toBe("listening");
    });

    it("Skip while paused drops the frozen reply; voice mode stays paused, and on resume the next waiting reply plays", async () => {
      const { result, rerender } = await startVoiceMode();
      rerender(baseArgs({ messages: [
        { type: "message", role: "assistant", content: "first reply", eventId: "p1", ts: Date.now() },
        { type: "message", role: "assistant", content: "second reply", eventId: "p2", ts: Date.now() },
      ] }));
      await flush();
      act(() => players[0].opts.onCanPlay?.()); // audio began: a pause freezes it in place
      expect(result.current.canSkip).toBe(true);

      act(() => result.current.togglePause());
      expect(result.current.phase).toBe("paused");
      expect(players[0].pause).toHaveBeenCalled();
      expect(result.current.canSkip).toBe(true);

      act(() => result.current.skipSpeech());
      await flush();
      expect(players[0].stop).toHaveBeenCalled();
      expect(result.current.phase).toBe("paused");
      expect(result.current.canSkip).toBe(false);
      expect(postSpeakStream).toHaveBeenCalledTimes(1);

      act(() => result.current.togglePause());
      await flush();
      expect(players[0].resume).not.toHaveBeenCalled();
      expect(postSpeakStream).toHaveBeenLastCalledWith("second reply", ["Ruth"]);
      expect(result.current.phase).toBe("speaking");
    });

    it("the trace level follows the reply while it's read aloud, the mic otherwise, and is flat while paused", async () => {
      const { result, rerender } = await startVoiceMode();
      setLevel(0.2);
      expect(result.current.readLevel()).toBeCloseTo(0.2);

      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "a reply", eventId: "l1", ts: Date.now() }] }));
      await flush();
      expect(result.current.phase).toBe("speaking");
      expect(result.current.readLevel()).toBe(0.25);

      act(() => result.current.togglePause());
      expect(result.current.readLevel()).toBe(0);
    });

    it("speaks only new assistant replies; ticks while the agent works; 'your turn' when it is done", async () => {
      const history: VoiceModeMessage[] = [
        { type: "message", role: "assistant", content: "old reply", eventId: "a0", ts: Date.now() },
      ];
      const { result, rerender } = await startVoiceMode(baseArgs({ messages: history }));
      expect(postSpeakStream).not.toHaveBeenCalled();

      // Agent starts working → ticking.
      rerender(baseArgs({ messages: history, isWorking: true }));
      await flush();
      expect(ticking).toBe(true);

      const next: VoiceModeMessage[] = [
        ...history,
        { type: "message", role: "user", content: "hi", eventId: "u1", ts: Date.now() },
        { type: "message", role: "assistant", content: "**Hello** there", eventId: "a1", ts: Date.now() },
      ];
      rerender(baseArgs({ messages: next, isWorking: true }));
      await flush();
      expect(postSpeakStream).toHaveBeenCalledWith("Hello there", ["Ruth"]);
      expect(result.current.phase).toBe("speaking");
      expect(ticking).toBe(false);
      // Half-duplex: recorder stopped while speaking.
      expect(MockMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);

      // Reply ends while the agent is still working → ticking again, no "your turn".
      act(() => players[0].opts.onEnded?.());
      await flush();
      expect(result.current.phase).toBe("listening");
      expect(ticking).toBe(true);
      expect(cuesPlayed).not.toContain("yourTurn");

      // Agent finishes → ticking stops, "your turn" (after a short settle).
      rerender(baseArgs({ messages: next, isWorking: false }));
      await flush(1000);
      expect(ticking).toBe(false);
      expect(cuesPlayed).toEqual(["yourTurn"]);
    });

    it("plays 'your turn' when the last reply ends and the agent is already done", async () => {
      const { rerender } = await startVoiceMode();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "done", eventId: "a1", ts: Date.now() }] }));
      await flush();
      act(() => players[0].opts.onEnded?.());
      await flush();
      expect(cuesPlayed).toEqual(["yourTurn"]);
    });

    it("ticks from the moment a message is sent, even before a dormant agent shows it is working", async () => {
      const { rerender } = await startVoiceMode();
      transcribeReturns("are you there");
      await sayUtterance();
      expect(cuesPlayed).toEqual(["sent"]);
      expect(ticking).toBe(true); // agent still asleep — isWorking is false
      rerender(baseArgs({ isWorking: true }));
      await flush();
      expect(ticking).toBe(true);
      rerender(baseArgs({ isWorking: false }));
      await flush(1000);
      expect(ticking).toBe(false);
      expect(cuesPlayed).toEqual(["sent", "yourTurn"]);
    });

    it("stops the post-send ticking if the agent never picks the message up", async () => {
      await startVoiceMode();
      transcribeReturns("hello?");
      await sayUtterance();
      expect(ticking).toBe(true);
      await flush(AWAIT_REPLY_MAX_MS + 100);
      expect(ticking).toBe(false);
    });

    it("stops ticking as soon as the user starts talking", async () => {
      const { rerender } = await startVoiceMode();
      rerender(baseArgs({ isWorking: true }));
      await flush();
      expect(ticking).toBe(true);
      setLevel(0.2);
      await flush(400);
      expect(ticking).toBe(false);
    });

    it("queues replies instead of cutting one off with the next", async () => {
      const { rerender } = await startVoiceMode();
      rerender(baseArgs({
        messages: [
          { type: "message", role: "assistant", content: "first", eventId: "a1", ts: Date.now() },
          { type: "message", role: "assistant", content: "second", eventId: "a2", ts: Date.now() },
        ],
      }));
      await flush();
      expect(postSpeakStream).toHaveBeenCalledTimes(1);
      expect(postSpeakStream).toHaveBeenLastCalledWith("first", ["Ruth"]);
      act(() => players[0].opts.onEnded?.());
      await flush();
      expect(postSpeakStream).toHaveBeenCalledTimes(2);
      expect(postSpeakStream).toHaveBeenLastCalledWith("second", ["Ruth"]);
      expect(players[0].stop).not.toHaveBeenCalled();
    });

    it("says it couldn't speak when the voice service fails — never silently", async () => {
      postSpeakStream.mockResolvedValueOnce(new Response(null, { status: 503 }));
      const { result, rerender } = await startVoiceMode();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush();
      expect(postSpeakStream).toHaveBeenCalledTimes(1);
      expect(result.current.errorMessage).toBe("Voice mode: couldn't speak that reply");
      expect(cuesPlayed).toContain("error");
      expect(result.current.phase).toBe("listening");
    });

    it("reports a mid-stream speak failure once", async () => {
      const { result, rerender } = await startVoiceMode();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush();
      act(() => players[players.length - 1].opts.onError?.(new Error("stream dropped")));
      await flush();
      expect(result.current.errorMessage).toBe("Voice mode: couldn't speak that reply");
      expect(cuesPlayed.filter((c) => c === "error")).toHaveLength(1);
    });

    it("does not talk over the user mid-utterance", async () => {
      const { result, rerender } = await startVoiceMode();
      setLevel(0.2);
      await flush(400);
      expect(result.current.phase).toBe("hearing");
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush(200);
      expect(postSpeakStream).not.toHaveBeenCalled();
      transcribeReturns("and another thing");
      setLevel(0);
      await flush(PIECE_GAP_MS + TIMED_END_MS + 200);
      expect(postSpeakStream).toHaveBeenCalledWith("reply", ["Ruth"]);
    });
  });

  describe("speak buttons (bubble / file read-aloud)", () => {
    /** Stand-in for useSpeakPlayback: takes the singleton and reports its state. */
    function fakeButton() {
      const owner = Symbol("bubble");
      const stop = vi.fn();
      const set = (state: ButtonSpeechState) => act(() => setButtonSpeechState(owner, state));
      const pause = vi.fn(() => setButtonSpeechState(owner, "paused"));
      const resume = vi.fn(() => setButtonSpeechState(owner, "playing"));
      return {
        owner,
        stop,
        pause,
        resume,
        start() {
          // Same order as useSpeakPlayback.startSpeak + playPiece.
          act(() => {
            getCurrentPlayer()?.stop();
            takeOverForButton(owner);
            setButtonControls(owner, { pause, resume });
            setButtonSpeechState(owner, "loading");
            setCurrentPlayer({ play: vi.fn(), stop, pause: vi.fn(), resume: vi.fn() });
            setCurrentOwner(owner);
          });
        },
        set,
        end() {
          act(() => clearCurrentPlayer());
        },
      };
    }

    it("a bubble tapped before voice mode starts counts as speaking, then it's your turn", async () => {
      const bubble = fakeButton();
      bubble.start();
      bubble.set("playing");
      const { result } = await startVoiceMode();
      expect(result.current.phase).toBe("speaking");
      expect(MockMediaRecorder.instances).toHaveLength(0);

      bubble.end();
      await flush();
      expect(result.current.phase).toBe("listening");
      expect(MockMediaRecorder.instances.some((r) => r.state === "recording")).toBe(true);
      expect(cuesPlayed).toEqual(["yourTurn"]);
    });

    it("a bubble tapped while listening stops listening; pausing it hands the turn back", async () => {
      const { result } = await startVoiceMode();
      expect(result.current.phase).toBe("listening");
      const bubble = fakeButton();
      bubble.start();
      await flush();
      expect(result.current.phase).toBe("speaking");
      expect(MockMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);

      bubble.set("paused");
      await flush();
      expect(result.current.phase).toBe("listening");
      expect(cuesPlayed).not.toContain("yourTurn");

      bubble.set("playing");
      await flush();
      expect(result.current.phase).toBe("speaking");
    });

    it("replies wait for the bubble to finish, then play (no 'your turn' in between)", async () => {
      const bubble = fakeButton();
      const { result, rerender } = await startVoiceMode();
      bubble.start();
      bubble.set("playing");
      await flush();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush();
      expect(postSpeakStream).not.toHaveBeenCalled();
      expect(bubble.stop).not.toHaveBeenCalled();

      bubble.end();
      await flush();
      expect(postSpeakStream).toHaveBeenCalledWith("reply", ["Ruth"]);
      expect(result.current.phase).toBe("speaking");
      expect(cuesPlayed).not.toContain("yourTurn");
    });

    it("pausing voice mode pauses a talking bubble through its own pause; resume carries it on", async () => {
      const bubble = fakeButton();
      const { result } = await startVoiceMode();
      bubble.start();
      bubble.set("playing");
      await flush();
      act(() => result.current.togglePause());
      await flush();
      expect(bubble.pause).toHaveBeenCalledTimes(1);
      expect(bubble.stop).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("paused");
      // Not listening while paused, even though the bubble handed the turn back.
      expect(MockMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);
      expect(cuesPlayed).not.toContain("yourTurn");

      act(() => result.current.togglePause());
      await flush();
      expect(bubble.resume).toHaveBeenCalledTimes(1);
      expect(result.current.phase).toBe("speaking");
      expect(getCurrentOwner()).toBe(bubble.owner);
    });

    it("a bubble the user paused themselves stays paused across a voice-mode pause", async () => {
      const bubble = fakeButton();
      const { result } = await startVoiceMode();
      bubble.start();
      bubble.set("paused");
      await flush();
      act(() => result.current.togglePause());
      act(() => result.current.togglePause());
      await flush();
      expect(bubble.pause).not.toHaveBeenCalled();
      expect(bubble.resume).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("listening");
    });

    it("tapping a bubble mid-reply cuts the reply without a 'your turn' over the bubble", async () => {
      const { result, rerender } = await startVoiceMode();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush();
      expect(result.current.phase).toBe("speaking");
      const bubble = fakeButton();
      bubble.start();
      await flush(1000);
      expect(players[0].stop).toHaveBeenCalled();
      expect(result.current.phase).toBe("speaking");
      expect(cuesPlayed).not.toContain("yourTurn");

      bubble.end();
      await flush();
      expect(result.current.phase).toBe("listening");
      expect(cuesPlayed).toEqual(["yourTurn"]);
    });

    it("switching bubbles is seamless: no 'your turn', mic stays off, queued reply kept", async () => {
      const a = fakeButton();
      const { result, rerender } = await startVoiceMode();
      a.start();
      a.set("playing");
      await flush();
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "reply", eventId: "a1", ts: Date.now() }] }));
      await flush();
      const recordersBefore = MockMediaRecorder.instances.length;

      const b = fakeButton();
      b.start();
      await flush();
      expect(a.stop).toHaveBeenCalled();
      expect(result.current.phase).toBe("speaking");
      expect(cuesPlayed).not.toContain("yourTurn");
      expect(MockMediaRecorder.instances).toHaveLength(recordersBefore);
      expect(postSpeakStream).not.toHaveBeenCalled();

      b.end();
      await flush();
      expect(postSpeakStream).toHaveBeenCalledWith("reply", ["Ruth"]);
    });

    it("no ticking while a bubble plays, even with the agent working", async () => {
      const bubble = fakeButton();
      const { rerender } = await startVoiceMode();
      bubble.start();
      await flush();
      rerender(baseArgs({ isWorking: true }));
      await flush();
      expect(ticking).toBe(false);
      bubble.end();
      await flush();
      expect(ticking).toBe(true);
      expect(cuesPlayed).not.toContain("yourTurn");
    });
  });

  describe("review hardening", () => {
    it("bails (never sends around the gap) when a closed piece comes back with no audio", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("first part");
      await sayPiece();
      // The next recorder loses its audio (iOS dropped data).
      const rec = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
      rec.stop = vi.fn(() => {
        rec.state = "inactive";
        rec.onstop?.();
      });
      await sayPiece();
      await flush(TIMED_END_MS);
      expect(send).not.toHaveBeenCalled();
      expect(cuesPlayed).toContain("error");
      expect(result.current.phase).toBe("off");
    });

    it("logs a stalled recorder's state when its stop never completes (iOS)", async () => {
      const warn = vi.spyOn(console, "warn");
      const info = vi.spyOn(console, "info");
      await startVoiceMode(baseArgs());
      transcribeReturns("first part");
      await sayPiece();
      const rec = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
      rec.stop = vi.fn(() => {}); // neither data nor onstop ever arrive
      await sayPiece();
      await flush(9000);
      const lines = (spy: typeof warn) => spy.mock.calls.map((c) => String(c[0]));
      expect(lines(info).some((l) => /\[voice-mode\] recorder-start state=recording .*rid=\d+/.test(l))).toBe(true);
      expect(lines(info).some((l) => /\[voice-mode\] recorder-stop rid=\d+ state=recording keep=true ageMs=\d+ chunks=0/.test(l))).toBe(true);
      expect(lines(warn).some((l) => /\[voice-mode\] recorder-onstop-watchdog rid=\d+ state=recording chunks=0/.test(l))).toBe(true);
    });

    it("records in timeslices so the recorder hands over audio as it goes", async () => {
      await startVoiceMode(baseArgs());
      expect(MockMediaRecorder.instances[0].start).toHaveBeenCalledWith(RECORDER_TIMESLICE_MS);
    });

    it("salvages the sliced audio when a stopped recorder never delivers (iOS)", async () => {
      const send = vi.fn(() => true);
      const warn = vi.spyOn(console, "warn");
      const { result } = await startVoiceMode(baseArgs({ send }));
      const rec = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
      // Slices arrived while recording; then stop() drops both data and onstop.
      rec.mimeType = "audio/mp4";
      rec.ondataavailable?.({ data: new Blob(["slice1"], { type: "audio/mp4" }) });
      rec.ondataavailable?.({ data: new Blob(["slice2"], { type: "audio/mp4" }) });
      rec.stop = vi.fn(() => {
        rec.state = "inactive";
      });
      transcribeReturns("check the build");
      await sayPiece();
      await flush(9000 + TIMED_END_MS);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\[voice-mode\] recorder-onstop-salvaged via=watchdog rid=\d+ chunks=2 bytes=12 /.test(l))).toBe(true);
      expect(cuesPlayed).not.toContain("error");
      expect(send).toHaveBeenCalled();
      expect(result.current.phase).not.toBe("off");
    });

    it("salvages the sliced audio when the browser stopped the recorder itself (iOS interruption)", async () => {
      const send = vi.fn(() => true);
      const warn = vi.spyOn(console, "warn");
      await startVoiceMode(baseArgs({ send }));
      const rec = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
      rec.mimeType = "audio/mp4";
      rec.ondataavailable?.({ data: new Blob(["slice1"], { type: "audio/mp4" }) });
      transcribeReturns("check the build");
      setLevel(0.2);
      await flush(600);
      rec.state = "inactive"; // stopped mid-piece, final data/onstop never fire
      setLevel(0);
      await flush(PIECE_GAP_MS + 100 + TIMED_END_MS);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /\[voice-mode\] recorder-onstop-salvaged via=already-inactive rid=\d+ chunks=1 /.test(l))).toBe(true);
      expect(cuesPlayed).not.toContain("error");
      expect(send).toHaveBeenCalled();
    });

    it("bails when a transcription attempt hangs instead of waiting forever", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      stampedFetch.mockReturnValue(new Promise(() => {})); // never answers
      await sayPiece();
      await flush(TRANSCRIBE_WAIT_MS - 1000);
      expect(result.current.phase).not.toBe("off");
      expect(stampedFetch).toHaveBeenCalledTimes(1); // a slow answer is never re-sent
      await flush(2000);
      expect(send).not.toHaveBeenCalled();
      expect(cuesPlayed).toContain("error");
      expect(result.current.phase).toBe("off");
    });

    it("timed mode: short noises after speaking don't postpone the send", async () => {
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      transcribeReturns("check the build");
      await sayPiece();
      // A key clack every second — each under the speech threshold.
      for (let i = 0; i < 3; i += 1) {
        setLevel(0.2);
        await flush(100);
        setLevel(0);
        await flush(900);
      }
      expect(send).toHaveBeenCalledWith("check the build", expect.any(String));
    });

    it("phrase mode: a second send phrase while the first turn is still transcribing is honoured", async () => {
      setVoiceModeSettings({ endOfTurn: "phrase" });
      const send = vi.fn(() => true);
      await startVoiceMode(baseArgs({ send }));
      const first = transcribeDeferred();
      await sayPiece();
      transcribeReturns("over");
      await sayPiece();
      transcribeReturns("now the second message. Over.");
      await sayPiece();
      expect(send).not.toHaveBeenCalled();
      first("the first message");
      await flush();
      expect(send).toHaveBeenNthCalledWith(1, "the first message", expect.any(String));
      expect(send).toHaveBeenNthCalledWith(2, "now the second message.", expect.any(String));
    });

    it("a piece from a stopped session can't touch a new one", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      const stale = transcribeDeferred();
      await sayPiece();
      act(() => result.current.stop());
      await flush(2000);
      act(() => result.current.start());
      await flush();
      stale("stop voice mode");
      await flush(TIMED_END_MS * 2);
      expect(result.current.phase).toBe("listening");
      expect(send).not.toHaveBeenCalled();
    });

    it("plays 'your turn' once when the agent goes idle just before its last reply lands", async () => {
      const { rerender } = await startVoiceMode(baseArgs({ isWorking: true }));
      rerender(baseArgs({ isWorking: false }));
      await flush(100);
      rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "final", eventId: "a1", ts: Date.now() }] }));
      await flush(1000);
      act(() => players[0].opts.onEnded?.());
      await flush(1000);
      expect(cuesPlayed.filter((c) => c === "yourTurn")).toHaveLength(1);
    });

    it("only the first piece of a draft carries the host (for the server's slash rewrite)", async () => {
      await startVoiceMode();
      transcribeReturns("slash deploy");
      await sayPiece();
      transcribeReturns("slash not a command");
      await sayPiece();
      const forms = stampedFetch.mock.calls.map((c) => (c[1] as { body: FormData }).body);
      expect(forms[0].get("hostId")).toBe("1");
      expect(forms[1].get("hostId")).toBeNull();
    });
  });

  describe("manual mic + lifecycle", () => {
    it("pauses (and drops the piece being recorded) while the manual mic is recording", async () => {
      const send = vi.fn(() => true);
      const { result, rerender } = await startVoiceMode(baseArgs({ send }));
      setLevel(0.2);
      await flush(400);
      rerender(baseArgs({ send, suspended: true }));
      await flush();
      expect(result.current.phase).toBe("paused");
      setLevel(0);
      await flush(TIMED_END_MS * 2);
      expect(stampedFetch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      rerender(baseArgs({ send, suspended: false }));
      await flush();
      expect(result.current.phase).toBe("listening");
    });

    it("survives the mic track being ended by the manual mic (iOS) and re-acquires it afterwards", async () => {
      const { result, rerender } = await startVoiceMode();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      rerender(baseArgs({ suspended: true }));
      await flush();
      act(() => track.onended?.());
      await flush();
      expect(result.current.active).toBe(true);
      expect(result.current.phase).toBe("paused");
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      rerender(baseArgs({ suspended: false }));
      await flush();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(result.current.phase).toBe("listening");
    });

    it("cuts the current reply when the manual mic starts, and speaks the queue after release", async () => {
      const { result, rerender } = await startVoiceMode();
      const messages = [
        { type: "message", role: "assistant", content: "first", eventId: "a1", ts: Date.now() },
        { type: "message", role: "assistant", content: "second", eventId: "a2", ts: Date.now() },
      ];
      rerender(baseArgs({ messages }));
      await flush();
      expect(result.current.phase).toBe("speaking");
      rerender(baseArgs({ messages, suspended: true }));
      await flush();
      expect(players[0].stop).toHaveBeenCalled();
      expect(result.current.phase).toBe("paused");
      expect(postSpeakStream).toHaveBeenCalledTimes(1);
      rerender(baseArgs({ messages, suspended: false }));
      await flush();
      expect(postSpeakStream).toHaveBeenCalledTimes(2);
      expect(postSpeakStream).toHaveBeenLastCalledWith("second", ["Ruth"]);
    });

    it("stop() releases mic, wake lock and audio context, and drops any draft", async () => {
      const send = vi.fn(() => true);
      const { result } = await startVoiceMode(baseArgs({ send }));
      transcribeReturns("half a thought");
      await sayPiece();
      act(() => result.current.stop());
      await flush(TIMED_END_MS * 2);
      expect(result.current.phase).toBe("off");
      expect(send).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
      expect(wakeLockRelease).toHaveBeenCalled();
    });
  });
});

describe("useVoiceMode — pause", () => {
  const reply = (content: string, eventId: string): VoiceModeMessage => ({
    type: "message",
    role: "assistant",
    content,
    eventId,
    ts: Date.now(),
  });

  it("pausing while listening stops listening with the mic kept open but silent; resume listens again", async () => {
    const { result } = await startVoiceMode();
    expect(result.current.paused).toBe(false);
    const stops = track.stop.mock.calls.length;
    act(() => result.current.togglePause());
    await flush();
    expect(result.current.paused).toBe(true);
    expect(result.current.phase).toBe("paused");
    expect(result.current.active).toBe(true);
    expect(track.enabled).toBe(false);
    expect(track.stop.mock.calls.length).toBe(stops); // the mic stays open
    expect(MockMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);

    act(() => result.current.togglePause());
    await flush();
    expect(result.current.paused).toBe(false);
    expect(track.enabled).toBe(true);
    expect(result.current.phase).toBe("listening");
    expect(MockMediaRecorder.instances.some((r) => r.state === "recording")).toBe(true);
    expect(cuesPlayed).toEqual(["yourTurn"]);
  });

  it("paused time doesn't count toward the timed turn end: pausing mid-message doesn't send it", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    transcribeReturns("half a thought");
    await sayPiece();
    act(() => result.current.togglePause());
    await flush(TIMED_END_MS * 3);
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.togglePause());
    await flush(500);
    expect(send).not.toHaveBeenCalled();
    await flush(TIMED_END_MS);
    expect(send).toHaveBeenCalledWith("half a thought", expect.any(String));
  });

  it("pausing mid-sentence keeps the words said so far, and the message carries on after resume", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    transcribeReturns("first half");
    setLevel(0.2);
    await flush(600);
    act(() => result.current.togglePause());
    setLevel(0);
    await flush(TIMED_END_MS * 3);
    // The words up to the pause were transcribed, but nothing went out.
    expect(stampedFetch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.togglePause());
    transcribeReturns("second half");
    await sayUtterance();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("first half second half", expect.any(String));
  });

  it("a reply paused mid-sentence freezes, and carries on from the same spot on resume", async () => {
    const { result, rerender } = await startVoiceMode();
    rerender(baseArgs({ messages: [reply("first", "a1")] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => result.current.togglePause());
    await flush();
    expect(result.current.phase).toBe("paused");
    expect(players[0].pause).toHaveBeenCalledTimes(1);
    expect(players[0].stop).not.toHaveBeenCalled();
    // A reply arriving while paused waits.
    rerender(baseArgs({ messages: [reply("first", "a1"), reply("second", "a2")] }));
    await flush(5000);
    expect(postSpeakStream).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);

    act(() => result.current.togglePause());
    await flush();
    expect(players[0].resume).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("speaking");
    expect(cuesPlayed).not.toContain("yourTurn");
    act(() => players[0].opts.onEnded?.());
    await flush();
    expect(postSpeakStream).toHaveBeenLastCalledWith("second", ["Ruth"]);
  });

  it("a reply paused before any audio is read from the start on resume", async () => {
    const send = vi.fn(() => true);
    const { result, rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [reply("only", "a1")] }));
    await flush();
    act(() => result.current.togglePause());
    await flush();
    expect(players[0].stop).toHaveBeenCalled();
    // The speech request is cancelled, quietly.
    expect(speakSignals[speakSignals.length - 1]?.aborted).toBe(true);
    expect(cuesPlayed).not.toContain("error");
    expect(result.current.phase).toBe("paused");
    act(() => result.current.togglePause());
    await flush();
    expect(postSpeakStream).toHaveBeenCalledTimes(2);
    expect(postSpeakStream).toHaveBeenLastCalledWith("only", ["Ruth"]);
    expect(result.current.phase).toBe("speaking");
  });

  it("replies that arrive while paused wait until resume, then are read", async () => {
    const { result, rerender } = await startVoiceMode();
    act(() => result.current.togglePause());
    rerender(baseArgs({ messages: [reply("hello", "a1")] }));
    await flush(5000);
    expect(postSpeakStream).not.toHaveBeenCalled();
    act(() => result.current.togglePause());
    await flush();
    expect(postSpeakStream).toHaveBeenCalledWith("hello", ["Ruth"]);
    expect(result.current.phase).toBe("speaking");
    expect(cuesPlayed).not.toContain("yourTurn");
  });

  it("the working ticks go quiet while paused and come back on resume", async () => {
    const { result, rerender } = await startVoiceMode();
    rerender(baseArgs({ isWorking: true }));
    await flush();
    expect(ticking).toBe(true);
    act(() => result.current.togglePause());
    await flush();
    expect(ticking).toBe(false);
    act(() => result.current.togglePause());
    await flush();
    expect(ticking).toBe(true);
  });

  it("a held reply that errors while paused plays no 'your turn'", async () => {
    const { result, rerender } = await startVoiceMode();
    rerender(baseArgs({ messages: [reply("last", "a1")] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => result.current.togglePause());
    act(() => players[0].opts.onError?.(new Error("stream dropped")));
    await flush();
    expect(cuesPlayed).not.toContain("yourTurn");
    expect(result.current.phase).toBe("paused");
  });

  it("no 'your turn' while paused when the agent finishes", async () => {
    const { result, rerender } = await startVoiceMode(baseArgs({ isWorking: true }));
    act(() => result.current.togglePause());
    rerender(baseArgs({ isWorking: false }));
    await flush(5000);
    expect(cuesPlayed).not.toContain("yourTurn");
  });

  it("keeps a re-acquired mic silent while paused", async () => {
    const { result, rerender } = await startVoiceMode();
    act(() => result.current.togglePause());
    const track2 = { stop: vi.fn(), onended: null as null | (() => void), enabled: true };
    getUserMedia.mockResolvedValue({ getTracks: () => [track2], getAudioTracks: () => [track2] });
    act(() => track.onended?.());
    await flush();
    // Not re-acquired while paused; resume (a tap) takes the mic back.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("paused");
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(track2.enabled).toBe(true);
    expect(result.current.phase).toBe("listening");
  });

  it("starts every session unpaused, and is a no-op while off", async () => {
    const { result } = await startVoiceMode();
    act(() => result.current.togglePause());
    act(() => result.current.stop());
    await flush();
    expect(result.current.paused).toBe(false);
    act(() => result.current.togglePause());
    expect(result.current.paused).toBe(false);
    track.enabled = true;
    act(() => result.current.start());
    await flush();
    expect(result.current.paused).toBe(false);
    expect(track.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interruptions (shape-voice-mode-survives-call): the phone taking the audio
// is the user's pause; the play tap takes the mic back.
// ---------------------------------------------------------------------------

describe("useVoiceMode — interruptions", () => {
  const reply = (content: string, eventId: string): VoiceModeMessage => ({
    type: "message",
    role: "assistant",
    content,
    eventId,
    ts: Date.now(),
  });

  function freshMic(opts: { muted?: boolean } = {}): MockTrack {
    const t: MockTrack = { stop: vi.fn(), onended: null, onmute: null, enabled: true, muted: opts.muted ?? false };
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [t], getAudioTracks: () => [t] });
    return t;
  }

  it("a call mid-message pauses with the words kept; play takes the mic back and the message carries on", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    transcribeReturns("before the call");
    setLevel(0.2);
    await flush(600);
    act(() => track.onended?.());
    setLevel(0);
    await flush(TIMED_END_MS * 3);
    expect(result.current.paused).toBe(true);
    expect(result.current.phase).toBe("paused");
    expect(result.current.errorMessage).toBeNull();
    expect(track.stop).toHaveBeenCalled();
    // Nothing grabbed the mic back on its own, and nothing was sent.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(stampedFetch).toHaveBeenCalledTimes(1);

    const mic2 = freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic2.enabled).toBe(true);
    // Listening again, with the draft from before the call still in progress.
    expect(result.current.phase).toBe("hearing");
    expect(cuesPlayed).toContain("yourTurn");
    transcribeReturns("after the call");
    await sayUtterance();
    expect(send).toHaveBeenCalledWith("before the call after the call", expect.any(String));
  });

  it("the send phrase works again after a call", async () => {
    setVoiceModeSettings({ endOfTurn: "phrase", sendPhrase: "over" });
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    act(() => track.onmute?.());
    await flush();
    expect(result.current.phase).toBe("paused");
    freshMic();
    act(() => result.current.togglePause());
    await flush();
    transcribeReturns("ship it. Over.");
    await sayPiece();
    await flush();
    expect(send).toHaveBeenCalledWith("ship it.", expect.any(String));
  });

  it("the sound being interrupted while a reply is read holds it in place; play carries on from there", async () => {
    const { result, rerender } = await startVoiceMode();
    rerender(baseArgs({ messages: [reply("first", "a1")] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    const ctx = MockAudioContext.instances[0];
    ctx.state = "interrupted";
    act(() => ctx.onstatechange?.());
    await flush();
    expect(result.current.paused).toBe(true);
    expect(players[0].pause).toHaveBeenCalledTimes(1);
    expect(players[0].stop).not.toHaveBeenCalled();

    freshMic();
    ctx.state = "suspended";
    act(() => result.current.togglePause());
    await flush();
    expect(ctx.resume).toHaveBeenCalled();
    expect(players[0].resume).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("speaking");
  });

  it("exact-zero sound while listening pauses voice mode instead of sitting on Listening", async () => {
    const { result } = await startVoiceMode();
    deadSound = true;
    await flush(DEAD_SOUND_MS - 200);
    expect(result.current.phase).toBe("listening");
    await flush(400);
    expect(result.current.paused).toBe(true);
    expect(result.current.errorMessage).toBeNull();

    // Still dead after the tap: stays paused and says so.
    freshMic();
    act(() => result.current.togglePause());
    await flush(DEAD_SOUND_MS + 200);
    expect(result.current.paused).toBe(true);
    expect(result.current.errorMessage).toMatch(/isn't giving any sound/);

    // Sound back: the next tap carries on and clears the note.
    deadSound = false;
    freshMic();
    act(() => result.current.togglePause());
    await flush(DEAD_SOUND_MS + 200);
    expect(result.current.paused).toBe(false);
    expect(result.current.phase).toBe("listening");
    expect(result.current.errorMessage).toBeNull();
  });

  it("a mic still held by the call after the tap stays paused with a note", async () => {
    const { result } = await startVoiceMode();
    act(() => track.onended?.());
    await flush();
    const held = freshMic({ muted: true });
    act(() => result.current.togglePause());
    await flush();
    expect(result.current.paused).toBe(true);
    expect(result.current.errorMessage).toMatch(/still in use/);
    expect(held.stop).toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  it("a mic that can't be had after the tap keeps voice mode on and paused", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    transcribeReturns("keep me");
    await sayPiece();
    act(() => track.onended?.());
    await flush();
    getUserMedia.mockRejectedValueOnce(new Error("NotReadableError"));
    act(() => result.current.togglePause());
    await flush();
    expect(result.current.active).toBe(true);
    expect(result.current.paused).toBe(true);
    expect(result.current.errorMessage).toMatch(/still in use/);
    expect(cuesPlayed).not.toContain("error");
    expect(send).not.toHaveBeenCalled();
  });

  it("an interruption while already paused keeps the pause and takes the mic back on play", async () => {
    const { result } = await startVoiceMode();
    act(() => result.current.togglePause());
    act(() => track.onmute?.());
    await flush();
    expect(result.current.paused).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("listening");
  });

  it("a call while voice mode is still getting the mic: that mic is let go when it arrives", async () => {
    let deliver!: (s: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise((r) => (deliver = r)));
    const hook = renderHook((p: UseVoiceModeArgs) => useVoiceMode(p), { initialProps: baseArgs() });
    act(() => hook.result.current.start());
    const ctx = MockAudioContext.instances[0];
    ctx.state = "interrupted";
    act(() => ctx.onstatechange?.());
    await flush();
    expect(hook.result.current.paused).toBe(true);
    act(() => deliver(stream));
    await flush();
    expect(track.stop).toHaveBeenCalled();
    expect(MockMediaRecorder.instances).toHaveLength(0);
    // Play asks again.
    freshMic();
    act(() => hook.result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe("listening");
  });

  it("pausing while play is still getting the mic back: a refusal keeps voice mode on, and the next play asks again", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    transcribeReturns("keep me");
    await sayPiece();
    act(() => track.onended?.());
    await flush();
    let refuse!: (e: Error) => void;
    getUserMedia.mockReturnValueOnce(new Promise((_r, j) => (refuse = j)));
    act(() => result.current.togglePause()); // play
    act(() => result.current.togglePause()); // pause again before the mic arrives
    act(() => refuse(new Error("NotReadableError")));
    await flush();
    expect(result.current.active).toBe(true);
    expect(result.current.paused).toBe(true);
    expect(cuesPlayed).not.toContain("error");
    freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(result.current.phase).toBe("hearing");
    expect(send).not.toHaveBeenCalled();
  });

  it("a mic request the phone never answers ends in a plain pause with a note, and play asks again", async () => {
    const { result } = await startVoiceMode();
    act(() => track.onended?.());
    await flush();
    getUserMedia.mockReturnValueOnce(new Promise(() => {}));
    act(() => result.current.togglePause());
    await flush(RECOVER_MIC_TIMEOUT_MS + 100);
    expect(result.current.paused).toBe(true);
    expect(result.current.errorMessage).toMatch(/still in use/);
    freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(result.current.phase).toBe("listening");
  });

  it("play after an interruption starts a fresh sound context", async () => {
    const { result } = await startVoiceMode();
    act(() => track.onmute?.());
    await flush();
    freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(MockAudioContext.instances).toHaveLength(2);
    expect(MockAudioContext.instances[0].close).toHaveBeenCalled();
  });

  it("a gated mic that goes to exact zeros between words is not treated as dead", async () => {
    const { result } = await startVoiceMode();
    setLevel(0.2);
    await flush(100);
    setLevel(0);
    deadSound = true;
    await flush(DEAD_SOUND_MS * 3);
    expect(result.current.paused).toBe(false);
  });

  it("call watch: while the phone holds the sound it only nudges the context; once it's back, one quick mic check is let go and voice mode stays paused", async () => {
    const { result } = await startVoiceMode();
    const ctx = MockAudioContext.instances[0];
    ctx.state = "interrupted";
    act(() => ctx.onstatechange?.());
    await flush();
    expect(result.current.paused).toBe(true);
    ctx.resume.mockClear();
    await flush(CALL_WATCH_TICK_MS * 3);
    expect(ctx.resume).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // The call ends: the phone gives the sound back.
    ctx.state = "running";
    const check = freshMic();
    await flush(CALL_WATCH_TICK_MS);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(check.stop).toHaveBeenCalled();
    await flush(CALL_WATCH_TICK_MS * 10);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(result.current.paused).toBe(true);
    expect(result.current.phase).toBe("paused");

    // Play still takes the mic back, and the watch is over.
    const mic = freshMic();
    act(() => result.current.togglePause());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(mic.stop).not.toHaveBeenCalled();
    await flush(CALL_WATCH_TICK_MS * 10);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("call watch: a muted mic with the sound context never interrupted takes no mic check", async () => {
    const { result } = await startVoiceMode();
    act(() => track.onmute?.());
    await flush(CALL_WATCH_TICK_MS * 10);
    expect(result.current.paused).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("call watch: turning voice mode off ends it", async () => {
    const { result } = await startVoiceMode();
    const ctx = MockAudioContext.instances[0];
    ctx.state = "interrupted";
    act(() => ctx.onstatechange?.());
    await flush();
    act(() => result.current.stop());
    ctx.resume.mockClear();
    ctx.state = "running";
    await flush(CALL_WATCH_TICK_MS * 10);
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("the manual mic muting voice mode's mic is not an interruption", async () => {
    const { result, rerender } = await startVoiceMode();
    rerender(baseArgs({ suspended: true }));
    await flush();
    act(() => track.onmute?.());
    await flush();
    expect(result.current.paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heard note (shape-voice-heard-ordering): every send says what the user had
// actually heard, so the agent can place an answer whatever the transcript
// order says.
// ---------------------------------------------------------------------------

describe("heard note", () => {
  const reply = (eventId: string, content: string): VoiceModeMessage => ({
    type: "message",
    role: "assistant",
    content,
    eventId,
    ts: Date.now(),
  });
  const A = reply("a1", "On the compaction work, the summary now keeps the campaign pointer intact.");
  const B = reply("a2", "For the voice mode cleanup, the chip now shows Muted while listening is paused.");
  const noteOf = (send: ReturnType<typeof vi.fn>, call = 0) => send.mock.calls[call][1] as string;

  it("says nothing has been read aloud yet at the start of a session", async () => {
    const send = vi.fn(() => true);
    await startVoiceMode(baseArgs({ send }));
    transcribeReturns("hello");
    await sayUtterance();
    expect(noteOf(send)).toContain("None of your replies had been read aloud to the user yet");
  });

  it("names the reply the user heard to the end", async () => {
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onEnded?.());
    await flush();
    transcribeReturns("yes do that");
    await sayUtterance();
    expect(noteOf(send)).toContain(
      'What the user had heard when they spoke: your reply "On the compaction work, the summary now keeps the campaign pointer intact.".',
    );
    expect(noteOf(send)).toContain('Nothing you sent after your reply "On the compaction work');
    expect(noteOf(send)).not.toContain("won't be read aloud");
  });

  it("the race: a reply landing mid-sentence is named as queued, and the earlier one as heard", async () => {
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onEnded?.());
    await flush();
    // The user starts answering A; B arrives while they talk and is held.
    transcribeReturns("yes do that");
    await sayPiece();
    rerender(baseArgs({ send, messages: [A, B] }));
    await flush();
    expect(players).toHaveLength(1);
    await flush(TIMED_END_MS);
    const note = noteOf(send);
    expect(note).toContain('heard when they spoke: your reply "On the compaction work');
    expect(note).toContain(
      'Your reply starting "For the voice mode cleanup, the chip now shows Muted while listening…" hasn\'t been read to them yet; it\'s queued',
    );
    expect(note).not.toContain("skipped or couldn't be played");
    expect(note).toContain("Their words answer what they had heard");
    // B is still read aloud after the send.
    expect(postSpeakStream).toHaveBeenLastCalledWith(expect.stringContaining("For the voice mode cleanup"), ["Ruth"]);
  });

  it("names the reply in front of the user even when the next one hasn't landed yet", async () => {
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onEnded?.());
    await flush();
    transcribeReturns("go ahead");
    await sayUtterance();
    // Whatever the agent says next, this send is pinned to A.
    expect(noteOf(send)).toContain('heard when they spoke: your reply "On the compaction work');
  });

  it("a reply cut off partway, and one that couldn't be played, are reported once", async () => {
    postSpeakStream
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A, B] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onError?.(new Error("stream dropped")));
    await flush();
    transcribeReturns("skip those");
    await sayUtterance();
    const note = noteOf(send);
    expect(note).toContain('heard when they spoke: your reply "On the compaction work');
    expect(note).toContain("cut off partway, so they may not have heard all of it");
    expect(note).toContain('Your reply starting "For the voice mode cleanup');
    expect(note).toContain("was skipped or couldn't be played");
    transcribeReturns("and another thing");
    await sayUtterance();
    expect(noteOf(send, 1)).not.toContain("skipped or couldn't be played");
  });

  it("a reply that fails before any audio counts as missed", async () => {
    postSpeakStream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    transcribeReturns("what happened");
    await sayUtterance();
    const note = noteOf(send);
    expect(note).toContain("None of your replies had been read aloud");
    expect(note).toContain('Your reply starting "On the compaction work');
    expect(note).toContain("was skipped or couldn't be played");
  });

  it("a reply the user plays with a speak button counts as heard", async () => {
    const send = vi.fn(() => true);
    await startVoiceMode(baseArgs({ send, messages: [A, B] }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "began" }));
    transcribeReturns("about that");
    await sayUtterance();
    expect(noteOf(send)).toContain('heard when they spoke: your reply "On the compaction work');
    expect(noteOf(send)).toContain("cut off partway");
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "finished" }));
    transcribeReturns("got it");
    await sayUtterance();
    // Played on to the end: the same step, now whole — not a second one.
    expect(noteOf(send, 1)).toContain('in between, oldest first: your reply "On the compaction work, the summary now keeps the campaign pointer intact."; then they said "about that"');
    expect(noteOf(send, 1)).not.toContain("cut off");
  });

  it("ignores a speak button playing another conversation's reply", async () => {
    const send = vi.fn(() => true);
    await startVoiceMode(baseArgs({ send, messages: [A] }));
    act(() => reportHeard({ eventId: "other-pane", text: "Some other agent's words.", outcome: "finished" }));
    transcribeReturns("hello");
    await sayUtterance();
    expect(noteOf(send)).toContain("None of your replies had been read aloud");
    expect(noteOf(send)).not.toContain("other agent");
  });

  it("a reply that couldn't be played, then played with its speak button, counts as heard, not missed", async () => {
    postSpeakStream
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A, B] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onError?.(new Error("stream dropped")));
    await flush();
    act(() => reportHeard({ eventId: "a2", text: B.content as string, outcome: "began" }));
    act(() => reportHeard({ eventId: "a2", text: B.content as string, outcome: "finished" }));
    transcribeReturns("about the chip");
    await sayUtterance();
    const note = noteOf(send);
    expect(note).toContain(
      'oldest first: your reply "On the compaction work, the summary now keeps the campaign pointer intact." (cut off partway, so they may not have heard all of it); then your reply starting "For the voice mode cleanup',
    );
    expect(note).not.toContain("won't be read aloud");
  });

  it("the run follows the order the user heard things, not the transcript order", async () => {
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onEnded?.());
    await flush();
    // B lands mid-sentence and is held; it is read only after the send.
    transcribeReturns("drop that one for now");
    await sayPiece();
    rerender(baseArgs({ send, messages: [A, B] }));
    await flush();
    await flush(TIMED_END_MS);
    act(() => players[1].opts.onCanPlay?.());
    act(() => players[1].opts.onEnded?.());
    await flush();
    transcribeReturns("and the chip looks fine");
    await sayUtterance();
    expect(noteOf(send, 1)).toContain(
      'in between, oldest first: your reply "On the compaction work, the summary now keeps the campaign pointer intact."; ' +
        'then they said "drop that one for now"; then your reply starting "For the voice mode cleanup',
    );
    expect(noteOf(send, 1)).toContain('Nothing you sent after your reply starting "For the voice mode cleanup');
  });

  it("replaying a reply after saying something puts it after their words", async () => {
    const send = vi.fn(() => true);
    await startVoiceMode(baseArgs({ send, messages: [A, B] }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "began" }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "finished" }));
    transcribeReturns("say that again");
    await sayUtterance();
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "began" }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "finished" }));
    transcribeReturns("got it now");
    await sayUtterance();
    expect(noteOf(send, 1)).toContain(
      'in between, oldest first: your reply "On the compaction work, the summary now keeps the campaign pointer intact."; ' +
        'then they said "say that again"; then your reply "On the compaction work',
    );
  });

  it("a message typed while voice mode is on joins the run", async () => {
    const send = vi.fn(() => true);
    const { rerender } = await startVoiceMode(baseArgs({ send }));
    rerender(baseArgs({ send, messages: [A] }));
    await flush();
    act(() => players[0].opts.onCanPlay?.());
    act(() => players[0].opts.onEnded?.());
    await flush();
    const typed: VoiceModeMessage = { type: "message", role: "user", content: "typed it instead", eventId: "u9", ts: Date.now() };
    const spoken: VoiceModeMessage = {
      type: "message",
      role: "user",
      content: appendVoiceLabel("spoken earlier"),
      eventId: "u10",
      ts: Date.now(),
    };
    const wake: VoiceModeMessage = {
      type: "message",
      role: "user",
      content: "<task-notification><summary>Ambient watcher event</summary></task-notification>",
      eventId: "u11",
      ts: Date.now(),
    };
    rerender(baseArgs({ send, messages: [A, typed, spoken, wake] }));
    await flush();
    transcribeReturns("and now by voice");
    await sayUtterance();
    expect(noteOf(send)).toContain('then they said "typed it instead".');
    // A voice message in the feed was already counted when it was sent.
    expect(noteOf(send)).not.toContain("spoken earlier");
    // Wake-ups and other events in the feed aren't the user's words.
    expect(noteOf(send)).not.toContain("Ambient");
  });

  it("a replay that reports only its end still lands after what the user said", async () => {
    const send = vi.fn(() => true);
    await startVoiceMode(baseArgs({ send, messages: [A] }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "began" }));
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "finished" }));
    transcribeReturns("once more");
    await sayUtterance();
    act(() => reportHeard({ eventId: "a1", text: A.content as string, outcome: "finished" }));
    transcribeReturns("thanks");
    await sayUtterance();
    expect(noteOf(send, 1)).toContain('then they said "once more"; then your reply "On the compaction work');
  });
});

describe("keptDraftText", () => {
  it("keeps transcribed pieces in order and marks each run of lost pieces once", () => {
    expect(
      keptDraftText([
        { status: "done", text: "one" },
        { status: "pending", text: "" },
        { status: "pending", text: "" },
        { status: "done", text: "two" },
        { status: "pending", text: "" },
      ]),
    ).toBe(`one ${LOST_PIECE_MARKER} two ${LOST_PIECE_MARKER}`);
  });
  it("is empty when nothing was transcribed", () => {
    expect(keptDraftText([{ status: "pending", text: "" }])).toBe("");
    expect(keptDraftText([])).toBe("");
  });
});

describe("Sending: send cue and ticks from the turn's end", () => {
  it("plays the send cue and ticks as soon as the turn ends, through a slow transcription and the send", async () => {
    const send = vi.fn(() => true);
    const { result } = await startVoiceMode(baseArgs({ send }));
    const answer = transcribeDeferred();
    await sayPiece();
    expect(ticking).toBe(false); // still the user's turn
    await flush(TIMED_END_MS);
    expect(result.current.phase).toBe("transcribing");
    expect(cuesPlayed).toEqual(["sent"]);
    expect(ticking).toBe(true);
    await flush(30_000);
    expect(ticking).toBe(true);
    answer("slow but here");
    await flush();
    expect(send).toHaveBeenCalledWith("slow but here", expect.any(String));
    expect(cuesPlayed).toEqual(["sent"]); // once, not again on delivery
    expect(ticking).toBe(true); // awaiting the agent's reply now
  });

  it("stops ticking with the error cue when the turn can't be transcribed", async () => {
    const { result } = await startVoiceMode(baseArgs());
    let fail!: () => void;
    stampedFetch.mockReturnValueOnce(
      new Promise((r) => (fail = () => r({ ok: false, status: 502, json: async () => ({ error: "STT error" }) }))),
    );
    await sayUtterance();
    expect(ticking).toBe(true);
    fail();
    await flush();
    expect(cuesPlayed).toEqual(["sent", "error"]);
    expect(ticking).toBe(false);
    expect(result.current.phase).toBe("off");
  });

  it("ticks while sending even when a reply arrived during the dictation (it waits for the send)", async () => {
    const history: VoiceModeMessage[] = [];
    const { rerender } = await startVoiceMode(baseArgs({ messages: history }));
    const answer = transcribeDeferred();
    setLevel(0.2);
    await flush(600);
    rerender(baseArgs({ messages: [{ type: "message", role: "assistant", content: "a reply", eventId: "a1", ts: Date.now() }] }));
    setLevel(0);
    await flush(PIECE_GAP_MS + 100 + TIMED_END_MS);
    expect(postSpeakStream).not.toHaveBeenCalled(); // the reply waits
    expect(ticking).toBe(true);
    answer("my words");
    await flush();
  });

  it("a piece failing doesn't lose a piece still in flight: its words are waited for and kept, in order", async () => {
    const send = vi.fn(() => true);
    const onUndelivered = vi.fn();
    const { result } = await startVoiceMode(baseArgs({ send, onUndelivered }));
    const first = transcribeDeferred();
    await sayPiece();
    stampedFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: "STT error" }) });
    await sayPiece();
    await flush();
    // The error cue right away; voice mode waits for the first piece.
    expect(cuesPlayed).toEqual(["error"]);
    expect(onUndelivered).not.toHaveBeenCalled();
    expect(result.current.phase).not.toBe("off");
    first("the earlier piece");
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(onUndelivered).toHaveBeenCalledWith(`the earlier piece ${LOST_PIECE_MARKER}`, expect.stringMatching(/the rest is in the compose box/));
    expect(cuesPlayed).toEqual(["error"]); // not twice
    expect(result.current.phase).toBe("off");
  });

  it("sends the piece's measured length with it", async () => {
    await startVoiceMode(baseArgs());
    transcribeReturns("hello");
    await sayPiece(600);
    const form = (stampedFetch.mock.calls[0][1] as { body: FormData }).body;
    expect(Number(form.get("durationMs"))).toBeGreaterThan(0);
  });
});
