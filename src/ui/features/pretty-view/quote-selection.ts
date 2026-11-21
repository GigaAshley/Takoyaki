/**
 * Quote-to-reply (shape-quote-reply): select words in a message bubble, tap
 * the Quote button, and those words land in the compose box as quoted lines.
 *
 * Bubbles opt in by carrying QUOTE_SOURCE_ATTR on their outer element; in a
 * relay room they also carry QUOTE_NAME_ATTR, the name the quote is
 * attributed to. A selection is quotable when its non-blank text sits inside
 * exactly one such bubble of the pane — a drag that overshoots the bubble's
 * edge is clipped back to it, a drag across two bubbles is not quotable.
 */

export const QUOTE_SOURCE_ATTR = "data-pv-quote-source";
export const QUOTE_NAME_ATTR = "data-pv-quote-name";
/** Parts of a bubble that are never part of a quote (its name header, the
 *  "Asked you" line). */
export const QUOTE_SKIP_ATTR = "data-pv-no-quote";
/** On the compose box's main text area — where a quote is typed under. */
export const COMPOSE_PRIMARY_ATTR = "data-pv-compose-primary";
/** On a typeset formula: the formula as written, which a quote takes instead. */
export const QUOTE_TEX_ATTR = "data-pv-quote-tex";

// Bubble chrome (speak / copy / thumbs buttons, icons, screen-reader-only
// text) — the same exclusions as clean copy, plus quote-specific skips.
const DROP_SELECTOR = `button, svg, [aria-hidden='true'], [data-pv-no-copy], .sr-only, [${QUOTE_SKIP_ATTR}]`;

// Blocks that stand apart as paragraphs: a blank line after each (unless
// nested in a list item, where they're part of the item).
const PARAGRAPH_TAGS = new Set(["P", "PRE", "BLOCKQUOTE", "TABLE", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DETAILS"]);

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR",
  "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "DETAILS", "SUMMARY", "HR",
]);

export type QuotableSelection = {
  text: string;
  /** Who said it — set only for relay-room bubbles. */
  name: string | null;
  rect: { top: number; bottom: number; left: number; right: number };
};

/** The plain words of a cloned selection, line breaks kept. */
export function fragmentToText(fragment: DocumentFragment): string {
  // Math reads back as its source, not as the typeset glyphs.
  fragment.querySelectorAll(`[${QUOTE_TEX_ATTR}]`).forEach((el) => {
    el.replaceWith(document.createTextNode(el.getAttribute(QUOTE_TEX_ATTR) ?? ""));
  });
  fragment.querySelectorAll(DROP_SELECTOR).forEach((el) => el.remove());

  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      // Markup's own line breaks between blocks (between list items, table
      // rows, paragraphs) aren't words.
      const isBlock = (n: Node | null) => n instanceof Element && BLOCK_TAGS.has(n.tagName);
      if (t.trim() === "" && t.includes("\n") && (isBlock(node.previousSibling) || isBlock(node.nextSibling))) return;
      out += t;
      return;
    }
    if (!(node instanceof Element)) {
      node.childNodes.forEach(walk);
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block && out !== "" && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
    if ((node.tagName === "TD" || node.tagName === "TH") && node.nextElementSibling) out += "\t";
    if (block && !out.endsWith("\n")) out += "\n";
    if (PARAGRAPH_TAGS.has(node.tagName) && !node.parentElement?.closest("li") && !out.endsWith("\n\n")) out += "\n";
  };
  fragment.childNodes.forEach(walk);
  return out;
}

/** Selected words as quoted lines, attributed when `name` is set. */
export function formatQuote(text: string, name: string | null): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  if (kept.length === 0) return "";
  const body = kept.map((l) => (l === "" ? ">" : `> ${l}`));
  const who = name?.replace(/\s+/g, " ").trim();
  return [...(who ? [`> ${who}:`] : []), ...body].join("\n");
}

/** The compose box's text with a quote added at the end — a blank line
 *  before it when there's already text, and a blank line after so what's
 *  typed next is the reply, not part of the quote. */
export function appendQuote(current: string, quote: string): string {
  const before = current.replace(/\s+$/, "");
  return before === "" ? `${quote}\n\n` : `${before}\n\n${quote}\n\n`;
}

function clippedRange(range: Range, source: Element): Range {
  const clipped = range.cloneRange();
  // An end inside a formula takes the whole formula — a part of one has no
  // written form of its own.
  const formulaAt = (node: Node) => {
    const el = node instanceof Element ? node : node.parentElement;
    const f = el?.closest(`[${QUOTE_TEX_ATTR}]`);
    return f && source.contains(f) ? f : null;
  };
  const startFormula = formulaAt(clipped.startContainer);
  if (startFormula) clipped.setStartBefore(startFormula);
  const endFormula = formulaAt(clipped.endContainer);
  if (endFormula) clipped.setEndAfter(endFormula);
  const whole = document.createRange();
  whole.selectNodeContents(source);
  if (clipped.compareBoundaryPoints(Range.START_TO_START, whole) < 0) {
    clipped.setStart(whole.startContainer, whole.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, whole) > 0) {
    clipped.setEnd(whole.endContainer, whole.endOffset);
  }
  return clipped;
}

/** What the Quote button would quote for the current selection, or null
 *  when there's nothing quotable inside `root`. */
export function quotableSelection(selection: Selection | null, root: Element | null): QuotableSelection | null {
  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  let found: { source: Element; text: string; range: Range } | null = null;
  for (const source of Array.from(root.querySelectorAll(`[${QUOTE_SOURCE_ATTR}]`))) {
    if (!range.intersectsNode(source)) continue;
    const clipped = clippedRange(range, source);
    if (clipped.collapsed) continue;
    // A selection wholly inside a button (or other chrome) clones as bare
    // text, without the element that marks it as chrome — check its parents.
    const common = clipped.commonAncestorContainer;
    const commonEl = common instanceof Element ? common : common.parentElement;
    const chrome = commonEl?.closest(DROP_SELECTOR);
    if (chrome && source.contains(chrome)) continue;
    const text = fragmentToText(clipped.cloneContents());
    if (text.trim() === "") continue;
    // Words from two bubbles: not quotable.
    if (found) return null;
    found = { source, text, range: clipped };
  }
  if (!found) return null;
  const r = found.range.getBoundingClientRect();
  return {
    text: found.text,
    name: found.source.getAttribute(QUOTE_NAME_ATTR) || null,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
  };
}

export const QUOTE_BUTTON_W = 84;
export const QUOTE_BUTTON_H = 34;
const GAP = 8;
const TOUCH_HANDLE_GAP = 30;

/** Where the button sits: above the selection on desktop, below it on a
 *  touch screen (the phone's own copy bar sits above), kept on screen. */
export function quoteButtonPosition(
  rect: QuotableSelection["rect"],
  touch: boolean,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const centre = (rect.left + rect.right) / 2;
  const left = Math.min(Math.max(centre - QUOTE_BUTTON_W / 2, GAP), viewport.width - QUOTE_BUTTON_W - GAP);
  const above = rect.top - QUOTE_BUTTON_H - GAP;
  // On touch, clear the selection handles that hang below its end.
  const below = rect.bottom + (touch ? TOUCH_HANDLE_GAP : GAP);
  let top = touch ? below : above >= GAP ? above : below;
  // On a phone the copy bar can also drop below a selection at the top of
  // the screen; past the bottom edge, fall back above it.
  if (top + QUOTE_BUTTON_H > viewport.height - GAP) top = Math.max(GAP, above);
  return { top, left };
}
