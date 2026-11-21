// 2026-10-06 — integration tests for hands-free voice mode on the ComposeBox.
// 2026-10-09: voice mode moved off the mic long-press onto its own button in
// the aux row (left of Stop); the status pill was folded into that button,
// which widens into a chip (phase + label, × to end) while voice mode is on.
// The user's requirement still holds: voice mode must not take over anything
// it doesn't have to — e.g. paste into the compose box and hit Send while
// voice mode is on.
//
// Audio stack stubs mirror ComposeBox.hold-to-mic.test.tsx, plus an
// AudioContext/AnalyserNode whose level the test drives for VAD.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { ComposeBoxProps } from "./ComposeBox";
import { LOST_PIECE_MARKER, PIECE_GAP_MS, TIMED_END_MS } from "./useVoiceMode";
import { appendVoiceLabel } from "./voice-label";
import { __resetVoiceModeRegistryForTests } from "./voice-mode-registry";
import { textAreaSendKind } from "./text-area-sends";

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));
vi.mock("../../api/voice-api", () => ({ postSpeakStream: vi.fn().mockResolvedValue({ ok: true, status: 200 }) }));

import { ComposeBox } from "./ComposeBox";

let level = 0;

class MockAudioContext {
  state = "running";
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createAnalyser() {
    return {
      fftSize: 1024,
      // A real mic is never exactly silent: "silence" carries a faint hiss.
      getFloatTimeDomainData: (buf: Float32Array) => buf.fill(level || 1e-4),
    };
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

let getUserMedia: ReturnType<typeof vi.fn>;

function makeStream() {
  const track = { stop: vi.fn(), onended: null };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

function props(overrides: Partial<ComposeBoxProps> = {}): ComposeBoxProps {
  return {
    onSend: vi.fn(() => true),
    hostId: 1,
    tmuxSession: "s1",
    canSend: true,
    voiceModeFeed: { isWorking: false, messages: [], voices: ["Ruth"] },
    ...overrides,
  };
}

function mic(): HTMLButtonElement {
  const btn = screen.getByRole("button", { name: "Record voice" }) as HTMLButtonElement;
  Object.defineProperty(btn, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, right: 40, top: 0, bottom: 40, x: 0, y: 0, width: 40, height: 40, toJSON: () => ({}) }),
  });
  return btn;
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function startVoiceMode() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
  });
  await flush();
}

function chipPhase(): string | null {
  return screen.getByTestId("voice-mode-button").getAttribute("data-phase");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetVoiceModeRegistryForTests();
  level = 0;
  MockMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  vi.stubGlobal("AudioContext", MockAudioContext);
  getUserMedia = vi.fn().mockImplementation(() => Promise.resolve(makeStream()));
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    writable: true,
    configurable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ text: "spoken words" }) }),
  );
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComposeBox — hands-free voice mode (aux-row button)", () => {
  it("the button turns voice mode on and becomes the status chip; × turns it off", async () => {
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend })} />);
    expect(chipPhase()).toBe("off");

    await startVoiceMode();
    expect(chipPhase()).toBe("listening");
    expect(screen.getByTestId("mic-status").textContent).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Start voice mode" })).toBeNull();
    // Starting sent nothing and left no RecordingControls behind.
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel recording" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End voice mode" }));
    });
    expect(chipPhase()).toBe("off");
    expect(screen.getByRole("button", { name: "Start voice mode" })).toBeTruthy();
  });

  it("the voice-mode button sits right before the mic in the control row", () => {
    render(<ComposeBox {...props()} />);
    const vm = screen.getByTestId("voice-mode-button");
    const micBtn = screen.getByRole("button", { name: "Record voice" });
    const thumbs = screen.getByRole("button", { name: "Send 'thumbs up'" });
    expect(screen.getByTestId("compose-row").contains(vm)).toBe(true);
    expect(vm.nextElementSibling).toBe(micBtn);
    // eslint-disable-next-line no-bitwise
    expect(micBtn.compareDocumentPosition(thumbs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("voice mode's pill: end, live trace, pause, and a Skip that waits until something is read aloud", async () => {
    render(<ComposeBox {...props()} />);
    await startVoiceMode();
    const pill = screen.getByTestId("mic-pill");
    expect(pill.dataset.kind).toBe("voice");
    expect(within(pill).getByTestId("mic-waveform")).toBeTruthy();
    expect(within(pill).getByRole("button", { name: "End voice mode" })).toBeTruthy();
    const skip = within(pill).getByRole("button", { name: "Skip what's being read" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(true);
  });

  it("the pill's pause toggle pauses and resumes voice mode", async () => {
    render(<ComposeBox {...props()} />);
    await startVoiceMode();
    const pause = screen.getByRole("button", { name: "Pause voice mode" });
    expect(pause.hasAttribute("aria-pressed")).toBe(false);
    act(() => {
      fireEvent.click(pause);
    });
    expect(screen.getByTestId("mic-status").textContent).toBe("Paused");
    expect(screen.getByTestId("voice-mode-button").getAttribute("data-paused")).toBe("true");
    expect(chipPhase()).toBe("paused");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Resume voice mode" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("mic-status").textContent).toBe("Listening");
  });

  it("the chip does not show the agent-working state (the WIP indicator does)", async () => {
    render(<ComposeBox {...props({ voiceModeFeed: { isWorking: true, messages: [], voices: [] } })} />);
    await startVoiceMode();
    expect(screen.getByTestId("mic-status").textContent).toBe("Listening");
  });

  it("pasted text + Send still works while voice mode is on, and spoken words go out separately without touching the textarea", async () => {
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend })} />);
    await startVoiceMode();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "pasted stack trace" } });

    // Speak while there is a draft in the box.
    level = 0.2;
    await flush(500);
    level = 0;
    await flush(PIECE_GAP_MS + TIMED_END_MS + 200);
    expect(onSend).toHaveBeenCalledTimes(1);
    // Voice sends carry the voice label; typed sends below do not.
    expect(onSend.mock.calls[0][0]).toBe(
      appendVoiceLabel(
        "spoken words",
        "None of your replies had been read aloud to the user yet in this voice session. That includes anything you send before you read this. " +
          "Not heard yet doesn't mean missed: voice mode reads your replies aloud to them in order, so ones they haven't heard yet will still reach them. Don't repeat them. " +
          "Their words answer what they had heard, which may not be your latest message.",
      ),
    );
    expect(textarea.value).toBe("pasted stack trace");

    // Typed send through the regular Send button.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1][0]).toBe("pasted stack trace");
    // Voice mode is still on.
    expect(chipPhase()).toBe("listening");
  });

  it("the mic steps aside while voice mode's pill is open here, and comes back when it ends", async () => {
    render(<ComposeBox {...props()} />);
    expect(mic().disabled).toBe(false);
    await startVoiceMode();
    expect(screen.queryByRole("button", { name: "Record voice" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End voice mode" }));
    });
    expect(mic().disabled).toBe(false);
  });

  it("voice mode in one pane disables every mic and the voice-mode button in other panes", async () => {
    render(
      <>
        <div data-testid="pane-a"><ComposeBox {...props({ tmuxSession: "a" })} /></div>
        <div data-testid="pane-b"><ComposeBox {...props({ tmuxSession: "b" })} /></div>
        <div data-testid="pane-relay"><ComposeBox {...props({ tmuxSession: "r", voiceModeFeed: undefined })} /></div>
      </>,
    );
    const pane = (id: string) => within(screen.getByTestId(id));
    await act(async () => {
      fireEvent.click(pane("pane-a").getByRole("button", { name: "Start voice mode" }));
    });
    await flush();

    expect(pane("pane-a").getByTestId("voice-mode-button").getAttribute("data-phase")).toBe("listening");
    const otherStart = pane("pane-b").getByRole("button", { name: "Start voice mode" }) as HTMLButtonElement;
    expect(otherStart.disabled).toBe(true);
    expect(otherStart.title).toBe("Voice mode is on");
    expect(pane("pane-a").queryByRole("button", { name: "Record voice" })).toBeNull();
    for (const id of ["pane-b", "pane-relay"]) {
      expect((pane(id).getByRole("button", { name: "Record voice" }) as HTMLButtonElement).disabled).toBe(true);
    }

    // Ending it releases the lock everywhere else.
    await act(async () => {
      fireEvent.click(pane("pane-a").getByRole("button", { name: "End voice mode" }));
    });
    expect(otherStart.disabled).toBe(false);
    for (const id of ["pane-b", "pane-relay"]) {
      expect((pane(id).getByRole("button", { name: "Record voice" }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("unmounting the pane that owns voice mode re-enables the other panes", async () => {
    const { rerender } = render(
      <>
        <div key="a" data-testid="pane-a"><ComposeBox {...props({ tmuxSession: "a" })} /></div>
        <div key="b" data-testid="pane-b"><ComposeBox {...props({ tmuxSession: "b" })} /></div>
      </>,
    );
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("pane-a")).getByRole("button", { name: "Start voice mode" }));
    });
    await flush();
    expect((within(screen.getByTestId("pane-b")).getByRole("button", { name: "Record voice" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <>
        <div key="b" data-testid="pane-b"><ComposeBox {...props({ tmuxSession: "b" })} /></div>
      </>,
    );
    expect((screen.getByRole("button", { name: "Record voice" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Start voice mode" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the voice-mode button steps aside while this composer is recording", async () => {
    render(<ComposeBox {...props()} />);
    await act(async () => {
      fireEvent.click(mic());
    });
    await flush(50);
    expect(screen.getByRole("button", { name: "Cancel recording" })).toBeTruthy();
    // The mic has grown into the dictation pill; voice mode steps aside.
    expect(screen.queryByTestId("voice-mode-button")).toBeNull();
  });

  it("a manual recording in one pane disables the voice-mode button in other panes", async () => {
    render(
      <>
        <div data-testid="pane-a"><ComposeBox {...props({ tmuxSession: "a" })} /></div>
        <div data-testid="pane-b"><ComposeBox {...props({ tmuxSession: "b" })} /></div>
      </>,
    );
    const startA = within(screen.getByTestId("pane-a")).getByRole("button", { name: "Start voice mode" }) as HTMLButtonElement;
    expect(startA.disabled).toBe(false);

    const micB = within(screen.getByTestId("pane-b")).getByRole("button", { name: "Record voice" });
    await act(async () => {
      fireEvent.click(micB);
    });
    await flush(50);
    expect(within(screen.getByTestId("pane-b")).getByRole("button", { name: "Cancel recording" })).toBeTruthy();
    expect(startA.disabled).toBe(true);
    expect(startA.title).toBe("A mic is recording");

    await act(async () => {
      fireEvent.click(within(screen.getByTestId("pane-b")).getByRole("button", { name: "Cancel recording" }));
    });
    await flush(50);
    expect(startA.disabled).toBe(false);
  });

  it("pressing and holding the mic does nothing special — no record-and-send on release; a tap dictates", async () => {
    for (const voiceModeFeed of [props().voiceModeFeed, undefined]) {
      const onSend = vi.fn((_text: string, _mqid?: string) => true);
      const { unmount } = render(<ComposeBox {...props({ onSend, voiceModeFeed })} />);
      const btn = mic();
      fireEvent.pointerDown(btn, { pointerId: 1, clientX: 20, clientY: 20, timeStamp: 0 });
      await flush(700);
      await act(async () => {
        fireEvent.pointerUp(btn, { pointerId: 1, clientX: 20, clientY: 20, timeStamp: 700 });
      });
      await flush(50);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(screen.queryByTestId("mic-pill")).toBeNull();
      await act(async () => {
        fireEvent.click(mic());
      });
      await flush(50);
      expect(screen.getByTestId("mic-pill").dataset.kind).toBe("dictate");
      expect(onSend).not.toHaveBeenCalled();
      getUserMedia.mockClear();
      unmount();
    }
  });

  it("without a voiceModeFeed (relay) there is no voice-mode button", () => {
    render(<ComposeBox {...props({ voiceModeFeed: undefined })} />);
    expect(screen.queryByTestId("voice-mode-button")).toBeNull();
  });

  it("a spoken blocked command is dropped: nothing sent, no waiting for a reply, the refusal line shows, voice mode carries on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ text: "/clear" }) }),
    );
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend })} />);
    await startVoiceMode();

    level = 0.2;
    await flush(500);
    level = 0;
    await flush(PIECE_GAP_MS + TIMED_END_MS + 200);

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("That command can't be used here.")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(chipPhase()).toBe("listening");
  });

  it("when voice mode gives up, what was transcribed lands in the compose box, unsent, with the gap marked", async () => {
    const answers = [
      { ok: true, status: 200, json: () => Promise.resolve({ text: "first part of my thought" }) },
      { ok: false, status: 502, json: () => Promise.resolve({ error: "STT error", status: 502 }) },
    ];
    // Only transcriptions take the scripted answers (the cue sounds load through fetch too).
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) =>
        Promise.resolve(String(url).includes("/voice/transcribe") ? answers.shift() : { ok: true, status: 200, json: () => Promise.resolve({}) }),
      ),
    );
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend })} />);
    await startVoiceMode();

    level = 0.2;
    await flush(500);
    level = 0;
    await flush(PIECE_GAP_MS + 100);
    level = 0.2;
    await flush(500);
    level = 0;
    await flush(PIECE_GAP_MS + 100);

    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      `first part of my thought ${LOST_PIECE_MARKER}`,
    );
    expect(
      screen.getByText("Voice mode stopped: couldn't transcribe part of what you said — the rest is in the compose box, not sent"),
    ).toBeTruthy();
    expect(chipPhase()).toBe("off");
  });

  it("spoken words that aren't a command go out marked as text-area input", async () => {
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend })} />);
    await startVoiceMode();

    level = 0.2;
    await flush(500);
    level = 0;
    await flush(PIECE_GAP_MS + TIMED_END_MS + 200);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textAreaSendKind(onSend.mock.calls[0][1])).toBe("spoken");
  });

  it("a relay room's composer isn't checked: its messages go to chat, not into a harness", async () => {
    const onSend = vi.fn((_text: string, _mqid?: string) => true);
    render(<ComposeBox {...props({ onSend, mode: "relay", voiceModeFeed: undefined })} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/plan for tomorrow" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("That command can't be used here.")).toBeNull();
  });
});
