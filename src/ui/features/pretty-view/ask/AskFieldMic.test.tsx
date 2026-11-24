import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { UseVoiceRecordingReturn, VoiceRecordingState } from "../useVoiceRecording";
import {
  __resetVoiceModeRegistryForTests,
  registerManualRecording,
  registerVoiceModeActive,
  useManualRecordingAnywhere,
} from "../voice-mode-registry";

// A recorder the test drives: start/stop flip the state, endAppend resolves
// with whatever transcript the test sets.
const fake = vi.hoisted(() => ({
  state: "idle" as VoiceRecordingState,
  transcript: "spoken words" as string | null,
  /** Mic permission still pending: start() leaves the state at "idle". */
  holdStart: false,
  /** Transcription waits until the test calls this. */
  gate: null as null | Promise<void>,
  setState: null as null | ((s: VoiceRecordingState) => void),
  start: vi.fn(),
  cancel: vi.fn(),
  endAppend: vi.fn(),
}));

vi.mock("../useVoiceRecording", async () => {
  const React = await import("react");
  return {
    useVoiceRecording: (): Partial<UseVoiceRecordingReturn> => {
      const [state, setState] = React.useState<VoiceRecordingState>("idle");
      fake.state = state;
      fake.setState = setState;
      return {
        state,
        errorMessage: null,
        start: () => { fake.start(); if (!fake.holdStart) setState("recording"); },
        cancel: async () => { fake.cancel(); setState("idle"); },
        endAppend: async (text: string) => {
          fake.endAppend(text);
          setState("transcribing");
          await (fake.gate ?? Promise.resolve());
          setState("idle");
          return fake.transcript === null ? null : { transcript: fake.transcript, glued: `${text} ${fake.transcript}` };
        },
      };
    },
  };
});

import { AskTray } from "./AskTray";
import { appendTranscript } from "./AskFieldMic";
import { parseAskBlock } from "./ask-format";
import type { QuestionAnswer } from "./answer-format";

const TWO_QUESTIONS = "questions:\n  - question: Plan?\n    header: Plan\n    options: [Keep, Change]\n  - question: Scale?\n    header: Scale\n    options: [Yes, No]";

function mount() {
  const r = parseAskBlock(TWO_QUESTIONS);
  if (!r.ok) throw new Error(r.error);
  const ask = r.ask;
  const onAnswer = vi.fn();
  const view = render(<AskTray open={{ ask, eventId: "e1", replaced: [] }} onAnswer={onAnswer} hostName="box" />);
  const setDisabled = (disabled: boolean) =>
    view.rerender(<AskTray open={{ ask, eventId: "e1", replaced: [] }} onAnswer={onAnswer} hostName="box" disabled={disabled} />);
  const tray = within(screen.getByTestId("ask-tray"));
  act(() => { fireEvent.click(tray.getByRole("button", { name: "Something else…" })); });
  const field = () => tray.getByLabelText("Something else") as HTMLInputElement;
  const mic = () => tray.getByTestId("ask-field-mic") as HTMLButtonElement;
  return { tray, field, mic, onAnswer, view, setDisabled };
}

beforeEach(() => {
  __resetVoiceModeRegistryForTests();
  fake.transcript = "spoken words";
  fake.holdStart = false;
  fake.gate = null;
  fake.start.mockClear();
  fake.cancel.mockClear();
  fake.endAppend.mockClear();
});
afterEach(() => __resetVoiceModeRegistryForTests());

describe("appendTranscript", () => {
  it("joins with one space, or none after whitespace or into an empty field", () => {
    expect(appendTranscript("", "hi")).toBe("hi");
    expect(appendTranscript("a", "hi")).toBe("a hi");
    expect(appendTranscript("a ", "hi")).toBe("a hi");
    expect(appendTranscript("a", "")).toBe("a");
  });
});

describe("Something-else mic", () => {
  it("tap records, tap again adds the words after what's typed — and sends nothing", async () => {
    const { field, mic, onAnswer } = mount();
    act(() => { fireEvent.change(field(), { target: { value: "Well" } }); });
    act(() => { fireEvent.click(mic()); });
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(mic().getAttribute("data-recording")).toBe("true");
    await act(async () => { fireEvent.click(mic()); });
    expect(fake.endAppend).toHaveBeenCalledWith("Well");
    expect(field().value).toBe("Well spoken words");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("the dictated answer goes out as the Something-else answer on Send", async () => {
    const { tray, field, mic, onAnswer } = mount();
    act(() => { fireEvent.click(mic()); });
    await act(async () => { fireEvent.click(mic()); });
    expect(field().value).toBe("spoken words");
    act(() => { fireEvent.click(tray.getByRole("tab", { name: /Scale/ })); });
    act(() => { fireEvent.click(tray.getByRole("radio", { name: "Yes" })); });
    act(() => { fireEvent.click(tray.getByTestId("ask-send")); });
    const answers: QuestionAnswer[] = onAnswer.mock.calls[0]![1];
    expect(answers[0]).toEqual({ kind: "other", text: "spoken words" });
  });

  it("a failed transcription leaves the field as it was", async () => {
    fake.transcript = null;
    const { field, mic } = mount();
    act(() => { fireEvent.change(field(), { target: { value: "kept" } }); });
    act(() => { fireEvent.click(mic()); });
    await act(async () => { fireEvent.click(mic()); });
    expect(field().value).toBe("kept");
  });

  it("is greyed out while voice mode is on, or another mic is recording", () => {
    const { mic } = mount();
    let release = () => {};
    act(() => { release = registerVoiceModeActive(Symbol("vm")); });
    expect(mic().disabled).toBe(true);
    expect(mic().title).toBe("Voice mode is on");
    act(() => release());
    act(() => { release = registerManualRecording(Symbol("other")); });
    expect(mic().disabled).toBe(true);
    expect(mic().title).toBe("A mic is recording");
    act(() => release());
    expect(mic().disabled).toBe(false);
  });

  it("while it records, every other mic sees the microphone taken", () => {
    let anywhere = false;
    function Probe() { anywhere = useManualRecordingAnywhere(); return null; }
    render(<Probe />);
    const { mic } = mount();
    expect(anywhere).toBe(false);
    act(() => { fireEvent.click(mic()); });
    expect(anywhere).toBe(true);
    expect(mic().disabled).toBe(false); // its own recording doesn't block its stop
  });

  it("going back to the choices mid-recording drops the recording", () => {
    const { tray, mic } = mount();
    act(() => { fireEvent.click(mic()); });
    act(() => { fireEvent.click(tray.getByRole("button", { name: "Back to the choices" })); });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
  });

  it("closing the field while still waiting for the mic stops the recording that's on its way", () => {
    fake.holdStart = true;
    const { tray, mic } = mount();
    act(() => { fireEvent.click(mic()); });
    act(() => { fireEvent.click(tray.getByRole("button", { name: "Back to the choices" })); });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
  });

  it("words still being written down when the field closes don't land on the answer", async () => {
    let release = () => {};
    fake.gate = new Promise<void>((r) => { release = r; });
    const { tray, mic, onAnswer } = mount();
    act(() => { fireEvent.click(mic()); });
    await act(async () => { fireEvent.click(mic()); });
    act(() => { fireEvent.click(tray.getByRole("button", { name: "Back to the choices" })); });
    act(() => { fireEvent.click(tray.getByRole("radio", { name: "Keep" })); });
    await act(async () => { release(); await Promise.resolve(); });
    act(() => { fireEvent.click(tray.getByRole("radio", { name: "Yes" })); });
    act(() => { fireEvent.click(tray.getByTestId("ask-send")); });
    const answers: QuestionAnswer[] = onAnswer.mock.calls[0]![1];
    expect(answers[0]).toMatchObject({ kind: "options", picked: [{ label: "Keep" }] });
  });

  it("a recording can still be stopped if the tray greys out meanwhile", () => {
    const { mic, setDisabled } = mount();
    act(() => { fireEvent.click(mic()); });
    act(() => setDisabled(true));
    expect(mic().disabled).toBe(false);
  });

  it("can't start while the tray is greyed out", () => {
    const { mic, setDisabled } = mount();
    act(() => setDisabled(true));
    expect(mic().disabled).toBe(true);
  });
});

describe("Typed-answer mic", () => {
  function mountKind(kind: "text" | "long-text") {
    const r = parseAskBlock(`kind: ${kind}\nquestion: What's number 1?`);
    if (!r.ok) throw new Error(r.error);
    const onAnswer = vi.fn();
    render(<AskTray open={{ ask: r.ask, eventId: "e1", replaced: [] }} onAnswer={onAnswer} hostName="box" />);
    const tray = within(screen.getByTestId("ask-tray"));
    const field = () => tray.getByLabelText("What's number 1?") as HTMLInputElement | HTMLTextAreaElement;
    const mic = () => tray.getByTestId("ask-field-mic") as HTMLButtonElement;
    return { tray, field, mic, onAnswer };
  }

  it.each(["text", "long-text"] as const)("a %s answer has a mic that adds the words to it", async (kind) => {
    const { field, mic, onAnswer } = mountKind(kind);
    act(() => { fireEvent.change(field(), { target: { value: "The" } }); });
    act(() => { fireEvent.click(mic()); });
    await act(async () => { fireEvent.click(mic()); });
    expect(field().value).toBe("The spoken words");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("a long-text answer's mic sits at the box's bottom", () => {
    const { mic } = mountKind("long-text");
    expect(mic().parentElement?.getAttribute("data-multiline")).toBe("true");
  });
});
