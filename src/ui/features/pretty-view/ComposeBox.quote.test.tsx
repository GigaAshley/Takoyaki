// shape-quote-reply — ComposeBox side: a quote lands at the end of the primary
// box, after anything typed, caret below it, once per request.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));

import { ComposeBox, type ComposeBoxProps } from "./ComposeBox";
import { getComposeDraft } from "@/api/compose-drafts-api";

function baseProps(overrides: Partial<ComposeBoxProps> = {}): ComposeBoxProps {
  return { onSend: vi.fn(() => true), hostId: 1, tmuxSession: "s1", ...overrides };
}

const primary = () => screen.getByPlaceholderText("Write a message…") as HTMLTextAreaElement;

describe("ComposeBox — a quote from the Quote button", () => {
  it("empty box → the quote, a blank line, the caret ready below", () => {
    const onQuoteApplied = vi.fn();
    const { rerender } = render(<ComposeBox {...baseProps({ onQuoteApplied })} />);
    rerender(<ComposeBox {...baseProps({ onQuoteApplied, quoteRequest: { id: "q1", text: "> hi" } })} />);
    expect(primary().value).toBe("> hi\n\n");
    expect(document.activeElement).toBe(primary());
    expect(primary().selectionStart).toBe(6);
    expect(onQuoteApplied).toHaveBeenCalledWith("q1");
  });

  it("typed text stays where it is; the quote follows it", () => {
    const { rerender } = render(<ComposeBox {...baseProps()} />);
    fireEvent.change(primary(), { target: { value: "already typed\n" } });
    rerender(<ComposeBox {...baseProps({ quoteRequest: { id: "q2", text: "> a\n> b" } })} />);
    expect(primary().value).toBe("already typed\n\n> a\n> b\n\n");
  });

  it("each request is applied once, even across re-renders", () => {
    const onQuoteApplied = vi.fn();
    const req = { id: "q3", text: "> once" };
    const { rerender } = render(<ComposeBox {...baseProps({ onQuoteApplied, quoteRequest: req })} />);
    rerender(<ComposeBox {...baseProps({ onQuoteApplied, quoteRequest: { ...req } })} />);
    expect(primary().value).toBe("> once\n\n");
    expect(onQuoteApplied).toHaveBeenCalledTimes(1);
  });

  it("a quoted draft doesn't open the slash list", () => {
    const { rerender } = render(<ComposeBox {...baseProps()} />);
    rerender(<ComposeBox {...baseProps({ quoteRequest: { id: "q4", text: "> /deploy" } })} />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a quote made while the saved draft is still loading goes after it, nothing lost", async () => {
    let resolve!: (v: { body: string; queueSlots: [] }) => void;
    vi.mocked(getComposeDraft).mockImplementationOnce(
      () => new Promise((r) => { resolve = r; }),
    );
    const { rerender } = render(<ComposeBox {...baseProps({ tmuxSession: "slow" })} />);
    rerender(<ComposeBox {...baseProps({ tmuxSession: "slow", quoteRequest: { id: "q5", text: "> early" } })} />);
    expect(primary().value).toBe("> early\n\n");
    await act(async () => {
      resolve({ body: "my saved draft", queueSlots: [] });
    });
    expect(primary().value).toBe("my saved draft\n\n> early\n\n");
  });
});
