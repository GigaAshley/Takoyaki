// ComposeBox `starter` — the compose box of a conversation that hasn't
// started yet (the new-conversation pane). Send starts the conversation with
// whatever is typed (empty is fine), the main button is Send throughout,
// nothing is saved as a draft, and nothing goes down the usual send path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));

import { ComposeBox, type ComposeBoxProps } from "./ComposeBox";
import { getComposeDraft, putComposeDraft } from "@/api/compose-drafts-api";

function props(starter: Partial<NonNullable<ComposeBoxProps["starter"]>> = {}, extra: Partial<ComposeBoxProps> = {}) {
  const onStart = vi.fn();
  const onSend = vi.fn(() => true);
  const p: ComposeBoxProps = {
    onSend,
    hostId: 3,
    tmuxSession: null,
    showPaperclip: false,
    starter: { placeholder: "What should Alicia do first? (optional)", canStart: true, busy: false, onStart, ...starter },
    ...extra,
  };
  return { p, onStart, onSend };
}

const textarea = (c: HTMLElement) => c.querySelector("textarea") as HTMLTextAreaElement;
const startButton = (c: HTMLElement) =>
  c.querySelector('button[data-main="true"]') as HTMLButtonElement;

describe("ComposeBox starter", () => {
  beforeEach(() => {
    vi.mocked(getComposeDraft).mockClear();
    vi.mocked(putComposeDraft).mockClear();
    localStorage.clear();
  });

  it("shows the starter's placeholder and a Send-shaped main button even with nothing typed", () => {
    const { p } = props();
    const { container } = render(<ComposeBox {...p} />);
    expect(textarea(container).placeholder).toBe("What should Alicia do first? (optional)");
    const btn = startButton(container);
    expect(btn).toHaveAttribute("data-action", "send");
    expect(btn).toHaveAttribute("aria-label", "Start the conversation");
    expect(btn.disabled).toBe(false);
    // No thumbs-up, no voice mode (none was fed).
    expect(container.querySelector('button[aria-label="Send \'thumbs up\'"]')).toBeNull();
    expect(container.querySelector('[data-testid="voice-mode-button"]')).toBeNull();
  });

  it("Send with nothing typed starts with an empty first message", () => {
    const { p, onStart, onSend } = props();
    const { container } = render(<ComposeBox {...p} />);
    fireEvent.click(startButton(container));
    expect(onStart).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Send carries the typed words and leaves them in the box", () => {
    const { p, onStart } = props();
    const { container } = render(<ComposeBox {...p} />);
    fireEvent.change(textarea(container), { target: { value: "  Sketch three ideas\r\nfor a card game  " } });
    fireEvent.click(startButton(container));
    expect(onStart).toHaveBeenCalledWith("Sketch three ideas\nfor a card game");
    expect(textarea(container).value).toContain("Sketch three ideas");
  });

  it("Enter starts too (desktop)", () => {
    const { p, onStart } = props({}, { isTouchDevice: false });
    const { container } = render(<ComposeBox {...p} />);
    fireEvent.change(textarea(container), { target: { value: "hello" } });
    fireEvent.keyDown(textarea(container), { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("hello");
  });

  it("waits for canStart, and does nothing while busy (spinner, disabled)", () => {
    const blocked = props({ canStart: false });
    const r1 = render(<ComposeBox {...blocked.p} />);
    expect(startButton(r1.container).disabled).toBe(true);
    fireEvent.keyDown(textarea(r1.container), { key: "Enter" });
    expect(blocked.onStart).not.toHaveBeenCalled();
    r1.unmount();

    const busy = props({ busy: true });
    const r2 = render(<ComposeBox {...busy.p} />);
    const btn = startButton(r2.container);
    expect(btn.disabled).toBe(true);
    expect(btn).toHaveAttribute("aria-label", "Starting the conversation");
    expect(btn.querySelector("svg.animate-spin")).not.toBeNull();
    fireEvent.keyDown(textarea(r2.container), { key: "Enter" });
    expect(busy.onStart).not.toHaveBeenCalled();
  });

  it("refuses a blocked command typed in the box, as a conversation does", () => {
    const { p, onStart } = props();
    const { container } = render(<ComposeBox {...p} />);
    fireEvent.change(textarea(container), { target: { value: "/login" } });
    fireEvent.click(startButton(container));
    expect(onStart).not.toHaveBeenCalled();
    expect(container.querySelector(".pv-compose-error")).not.toBeNull();
  });

  it("keeps no draft — nothing is loaded, saved or mirrored", async () => {
    vi.useFakeTimers();
    try {
      const { p } = props();
      const { container, unmount } = render(<ComposeBox {...p} />);
      fireEvent.change(textarea(container), { target: { value: "draft words" } });
      await vi.advanceTimersByTimeAsync(5000);
      unmount();
      expect(getComposeDraft).not.toHaveBeenCalled();
      expect(putComposeDraft).not.toHaveBeenCalled();
      expect(Object.keys(localStorage).filter((k) => k.startsWith("skynet:compose-draft:"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allowText false: nothing to type, no mic, no skills — Send still starts", () => {
    const { p, onStart } = props({ allowText: false, placeholder: "Press send to open the shell" });
    const { container } = render(<ComposeBox {...p} />);
    expect(textarea(container).disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Record voice"]')).toBeNull();
    expect(container.querySelector('[data-testid="skill-actions-button"]')).toBeNull();
    fireEvent.click(startButton(container));
    expect(onStart).toHaveBeenCalledWith("");
  });
});
