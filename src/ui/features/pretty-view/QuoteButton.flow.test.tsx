// shape-quote-reply — the whole path a user takes: select words in a bubble,
// the Quote button shows once the selection settles, tapping it puts the
// quote at the end of the compose box with the caret below it.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useCallback, useRef, useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));
vi.mock("@/api/voice-api", () => ({ postSpeakStream: vi.fn(), postSpeak: vi.fn(), SAMPLE_PHRASE: "Hi" }));
vi.mock("./webAudioStreamPlayer", () => ({ createWebAudioStreamPlayer: vi.fn() }));

import { ChatMessage } from "./ChatMessage";
import { ComposeBox } from "./ComposeBox";
import { QuoteButton, QUOTE_SETTLE_MS } from "./QuoteButton";
import { RelayChatBubble, RelayToYouBubble } from "./RelayBubbleParts";
import { formatQuote } from "./quote-selection";

beforeAll(() => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 200, bottom: 220, left: 40, right: 140, width: 100, height: 20, x: 40, y: 200, toJSON: () => ({}) }) as DOMRect;

  // jsdom has no layout: give the message list a screen-sized box.
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

// The same wiring PrettyView does: Quote → formatted quote → ComposeBox.
function Pane({ enabled = true, room = false, notified = false }: { enabled?: boolean; room?: boolean; notified?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [req, setReq] = useState<{ id: string; text: string } | null>(null);
  const seq = useRef(0);
  const onQuote = useCallback((text: string, name: string | null) => {
    const q = formatQuote(text, name);
    if (!q) return;
    seq.current += 1;
    setReq({ id: `q${seq.current}`, text: q });
  }, []);
  return (
    <>
      <div ref={rootRef}>
        {notified ? (
          <RelayToYouBubble testIdPrefix="relay-inbound" sender={{ name: "Finch", hue: 200, you: false }} failed="offline">
            {"Deploy finished, all green."}
          </RelayToYouBubble>
        ) : room ? (
          <>
            <RelayChatBubble testIdPrefix="relay-inbound" sender={{ name: "Bilbo", hue: 30, you: false }}>
              {"The ring is in the drawer.\nDon't tell anyone."}
            </RelayChatBubble>
            <ChatMessage role="user" content="Which drawer?" quoteName="alex" />
          </>
        ) : (
          <>
            <ChatMessage role="assistant" content={"First point here.\n\nSecond point here."} />
            <ChatMessage role="user" content="My own words." />
          </>
        )}
      </div>
      <div data-testid="outside">Not a bubble</div>
      <QuoteButton rootRef={rootRef} enabled={enabled} touch={false} onQuote={onQuote} />
      <ComposeBox
        onSend={() => true}
        hostId={1}
        tmuxSession="s1"
        quoteRequest={req}
        onQuoteApplied={(id) => setReq((cur) => (cur?.id === id ? null : cur))}
      />
    </>
  );
}

const box = () => screen.getByPlaceholderText("Write a message…") as HTMLTextAreaElement;

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function settle() {
  act(() => {
    vi.advanceTimersByTime(QUOTE_SETTLE_MS + 10);
  });
}

function textNode(text: string): Node {
  const el = screen.getByText(text, { exact: false });
  return el.firstChild!;
}

describe("quote to reply — user flow", () => {
  it("select part of an agent's reply → Quote → it lands in the box, caret below", () => {
    vi.useFakeTimers();
    render(<Pane />);
    selectText(textNode("Second point"), 0, 12);
    expect(screen.queryByTestId("pv-quote-button")).toBeNull(); // not until it settles
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));

    expect(box().value).toBe("> Second point\n\n");
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(box().value.length);
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(screen.queryByTestId("pv-quote-button")).toBeNull();
  });

  it("typed text is kept; quote, answer, quote builds a point-by-point reply", () => {
    vi.useFakeTimers();
    render(<Pane />);
    fireEvent.change(box(), { target: { value: "Thoughts:" } });

    selectText(textNode("First point"), 0, 11);
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));
    fireEvent.change(box(), { target: { value: `${box().value}agreed` } });

    selectText(textNode("My own words"), 0, 12);
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));

    expect(box().value).toBe("Thoughts:\n\n> First point\n\nagreed\n\n> My own words\n\n");
  });

  it("in a room, quotes name who said it — never the name header itself", () => {
    vi.useFakeTimers();
    render(<Pane room />);
    const body = screen.getByTestId("relay-inbound-body").firstChild!;
    selectText(body, 0, (body.textContent ?? "").length);
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));
    expect(box().value).toBe("> Bilbo:\n> The ring is in the drawer.\n> Don't tell anyone.\n\n");

    selectText(textNode("Which drawer"), 0, 12);
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));
    expect(box().value).toContain("> alex:\n> Which drawer\n\n");
  });

  it("a notification bubble is quotable, unnamed, without its 'not sent' mark", () => {
    vi.useFakeTimers();
    render(<Pane notified />);
    const bubble = screen.getByTestId("relay-inbound-bubble");
    const range = document.createRange();
    range.selectNodeContents(bubble);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    settle();
    fireEvent.click(screen.getByTestId("pv-quote-button"));
    expect(box().value).toBe("> Deploy finished, all green.\n\n");
  });

  it("a room's own-echo bubble shown as 'You' is quoted under the given name", () => {
    vi.useFakeTimers();
    const { container } = render(
      <RelayChatBubble testIdPrefix="relay-outbound" sender={{ name: "You", hue: null, you: true }} quoteName="alex">
        hi
      </RelayChatBubble>,
    );
    expect(container.querySelector("[data-pv-quote-name]")?.getAttribute("data-pv-quote-name")).toBe("alex");
  });

  it("no button for text outside a bubble, or across two bubbles", () => {
    vi.useFakeTimers();
    render(<Pane />);
    selectText(screen.getByTestId("outside").firstChild!, 0, 3);
    settle();
    expect(screen.queryByTestId("pv-quote-button")).toBeNull();

    const range = document.createRange();
    range.setStart(textNode("Second point"), 3);
    range.setEnd(textNode("My own words"), 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    settle();
    expect(screen.queryByTestId("pv-quote-button")).toBeNull();
  });

  it("the button goes away when the selection does", () => {
    vi.useFakeTimers();
    render(<Pane />);
    selectText(textNode("First point"), 0, 5);
    settle();
    expect(screen.getByTestId("pv-quote-button")).toBeTruthy();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByTestId("pv-quote-button")).toBeNull();
  });

  it("a selection scrolled out of the message list hides the button", () => {
    vi.useFakeTimers();
    render(<Pane />);
    const saved = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 900, bottom: 920, left: 40, right: 140, width: 100, height: 20, x: 40, y: 900, toJSON: () => ({}) }) as DOMRect;
    try {
      selectText(textNode("First point"), 0, 5);
      settle();
      expect(screen.queryByTestId("pv-quote-button")).toBeNull();
    } finally {
      Range.prototype.getBoundingClientRect = saved;
    }
  });

  it("no compose box, no Quote button", () => {
    vi.useFakeTimers();
    render(<Pane enabled={false} />);
    selectText(textNode("First point"), 0, 5);
    settle();
    expect(screen.queryByTestId("pv-quote-button")).toBeNull();
  });
});
