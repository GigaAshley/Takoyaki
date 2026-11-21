import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MicPill } from "./MicPill";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const base = { readLevel: () => 0.1, onEnd: vi.fn(), paused: false, onTogglePause: vi.fn() };

describe("MicPill", () => {
  it("dictation: ✕ cancels, pause, add to text — red, icons only", () => {
    const onAppend = vi.fn();
    const onEnd = vi.fn();
    render(<MicPill {...base} kind="dictate" onEnd={onEnd} onAppend={onAppend} />);
    const pill = screen.getByTestId("mic-pill");
    expect(pill.dataset.kind).toBe("dictate");
    expect(pill.dataset.tone).toBe("live");
    expect(pill.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to text" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAppend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  });

  it("paused: play icon labelled Resume, grey tone", () => {
    render(<MicPill {...base} kind="dictate" paused onAppend={vi.fn()} />);
    expect(screen.getByTestId("mic-pill").dataset.tone).toBe("paused");
    expect(screen.getByRole("button", { name: "Resume recording" })).toBeTruthy();
  });

  it("while the mic opens: spinner, pause and add-to-text held", () => {
    render(<MicPill {...base} kind="dictate" busy pauseDisabled appendDisabled onAppend={vi.fn()} />);
    expect(screen.getByTestId("mic-pill").dataset.busy).toBe("true");
    expect((screen.getByRole("button", { name: "Pause recording" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add to text" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("voice mode: Skip holds its place, greyed until a reply is read, then live", () => {
    const onSkip = vi.fn();
    const { rerender } = render(<MicPill {...base} kind="voice" onSkip={onSkip} />);
    const skip = screen.getByRole("button", { name: "Skip what's being read" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(true);
    rerender(<MicPill {...base} kind="voice" onSkip={onSkip} speaking />);
    expect(screen.getByTestId("mic-pill").dataset.tone).toBe("speaking");
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "End voice mode" })).toBeTruthy();
  });

  it("voice mode: Skip stays live for a reply frozen by pause", () => {
    render(<MicPill {...base} kind="voice" onSkip={vi.fn()} paused skipEnabled />);
    expect((screen.getByRole("button", { name: "Skip what's being read" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the trace starts fresh when the sound switches between the reply and the mic, but a pause keeps it", () => {
    const props = { ...base, kind: "voice" as const, onSkip: vi.fn() };
    const { rerender } = render(<MicPill {...props} speaking />);
    const replyTrace = screen.getByTestId("mic-waveform");
    rerender(<MicPill {...props} speaking={false} paused />);
    expect(screen.getByTestId("mic-waveform")).toBe(replyTrace);
    rerender(<MicPill {...props} speaking={false} />);
    expect(screen.getByTestId("mic-waveform")).not.toBe(replyTrace);
  });

  it("opening with focus lost (the tapped button is gone) puts focus on Pause", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(<MicPill {...base} kind="dictate" onAppend={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause recording" }));
  });
});
