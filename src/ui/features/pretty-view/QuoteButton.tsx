import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";
import {
  quotableSelection,
  quoteButtonPosition,
  QUOTE_BUTTON_H,
  QUOTE_BUTTON_W,
  type QuotableSelection,
} from "./quote-selection";

// shape-quote-reply: the Quote button that floats by a selection inside a
// message bubble. Appears once the selection settles, follows it while the
// conversation scrolls, goes away with it. Tapping hands the quote up and
// clears the selection.

/** How long the selection has to hold still before the button shows. */
export const QUOTE_SETTLE_MS = 150;

export function QuoteButton({
  rootRef,
  enabled,
  touch,
  onQuote,
  focusCompose,
}: {
  /** The pane's message list; only bubbles inside it can be quoted. */
  rootRef: RefObject<HTMLElement | null>;
  /** False while the pane has no compose box to put a quote in. */
  enabled: boolean;
  touch: boolean;
  onQuote: (text: string, name: string | null) => void;
  /** Focuses the compose box. Called inside the tap itself — iPhone only
   *  raises the keyboard for a focus made during the user's gesture. */
  focusCompose?: () => void;
}) {
  const [sel, setSel] = useState<QuotableSelection | null>(null);
  const shownKeyRef = useRef<string | null>(null);

  const read = useCallback(() => {
    const root = rootRef.current;
    let next = enabled ? quotableSelection(window.getSelection(), root) : null;
    // Scrolled out of the pane's message list (under its header, past its
    // edge): no button floating over the rest of the app.
    if (next && root) {
      const box = root.getBoundingClientRect();
      if (next.rect.bottom < box.top || next.rect.top > box.bottom) next = null;
    }
    setSel((cur) =>
      cur && next && cur.text === next.text && cur.name === next.name &&
      cur.rect.top === next.rect.top && cur.rect.left === next.rect.left &&
      cur.rect.bottom === next.rect.bottom && cur.rect.right === next.rect.right
        ? cur
        : next,
    );
    const key = next ? `${next.name ?? ""}:${next.text.length}` : null;
    if (key !== shownKeyRef.current) {
      shownKeyRef.current = key;
      if (next) console.info(`[quote] shown len=${next.text.length} named=${next.name !== null} touch=${touch}`);
    }
  }, [enabled, rootRef, touch]);

  useEffect(() => {
    if (!enabled) {
      setSel(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    const onSelectionChange = () => {
      // Hide while the selection is moving; show once it settles.
      setSel((cur) => (cur ? null : cur));
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, QUOTE_SETTLE_MS);
    };
    // Keep the button with its selection while the conversation scrolls.
    const onScroll = () => {
      if (shownKeyRef.current === null || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        read();
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      if (timer) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [enabled, read]);

  if (!sel) return null;
  const pos = quoteButtonPosition(sel.rect, touch, { width: window.innerWidth, height: window.innerHeight });

  return createPortal(
    <button
      type="button"
      data-testid="pv-quote-button"
      data-pv-no-quote=""
      className="pv-float pv-quote-btn"
      style={{ top: pos.top, left: pos.left, width: QUOTE_BUTTON_W, height: QUOTE_BUTTON_H }}
      // Keep the selection (and the page's focus) through the press; the
      // words are already captured either way.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const { text, name } = sel;
        setSel(null);
        shownKeyRef.current = null;
        window.getSelection()?.removeAllRanges();
        focusCompose?.();
        onQuote(text, name);
      }}
    >
      <Quote size={14} aria-hidden="true" />
      Quote
    </button>,
    document.body,
  );
}
