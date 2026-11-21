// shape-quote-reply — turning a selection inside a bubble into quoted lines.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  appendQuote,
  formatQuote,
  fragmentToText,
  quotableSelection,
  quoteButtonPosition,
  QUOTE_BUTTON_H,
  QUOTE_BUTTON_W,
} from "./quote-selection";

beforeAll(() => {
  // jsdom has no layout; the button position only needs a rect.
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 120, left: 40, right: 140, width: 100, height: 20, x: 40, y: 100, toJSON: () => ({}) }) as DOMRect;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function frag(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

describe("fragmentToText", () => {
  it("keeps line breaks: a blank line between paragraphs, one line per list item", () => {
    expect(fragmentToText(frag("<p>one</p>\n<p>two</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>"))).toBe("one\n\ntwo\n\na\nb\n\n");
    expect(formatQuote(fragmentToText(frag("<ul>\n<li>a</li>\n<li>b</li>\n</ul>")), null)).toBe("> a\n> b");
  });

  it("drops buttons, icons, screen-reader text and no-quote parts", () => {
    const text = fragmentToText(
      frag(
        '<div><span>keep</span><button>Speak</button><svg><text>x</text></svg>' +
          '<span class="sr-only">Asked you: hidden</span><div data-pv-no-quote>Bilbo</div></div>',
      ),
    );
    expect(text).toBe("keep\n");
  });

  it("reads typeset math back as its source", () => {
    const text = fragmentToText(
      frag(
        '<p>so <span class="pv-rich-math" data-pv-quote-tex="$x^2$"><span aria-hidden="true">' +
          '<span class="katex"><span class="katex-html">x2</span></span></span>' +
          '<span class="sr-only">x squared</span></span> grows</p>',
      ),
    );
    expect(text).toBe("so $x^2$ grows\n\n");
  });

  it("separates table cells and keeps line breaks", () => {
    expect(fragmentToText(frag("<table><tr><td>a</td><td>b</td></tr></table>x<br>y"))).toBe("a\tb\n\nx\ny");
  });
});

describe("formatQuote", () => {
  it("marks every line as quoted, keeping one blank quoted line between paragraphs", () => {
    expect(formatQuote("one\n\n\n\ntwo\n", null)).toBe("> one\n>\n> two");
  });

  it("drops leading and trailing blank lines and trailing spaces", () => {
    expect(formatQuote("\n\n  hello  \n\n", null)).toBe(">   hello");
  });

  it("names who said it when given a name", () => {
    expect(formatQuote("hi there", "Bilbo")).toBe("> Bilbo:\n> hi there");
    expect(formatQuote("hi", "Bil\nbo ")).toBe("> Bil bo:\n> hi");
  });

  it("nothing but whitespace makes no quote", () => {
    expect(formatQuote(" \n\t\n", "Bilbo")).toBe("");
  });

  it("never cuts a long quote short", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(formatQuote(long, null).split("\n")).toHaveLength(40);
  });
});

describe("appendQuote", () => {
  it("an empty box gets the quote and a blank line to type under", () => {
    expect(appendQuote("", "> q")).toBe("> q\n\n");
    expect(appendQuote("  \n", "> q")).toBe("> q\n\n");
  });

  it("typed text is kept, the quote follows it", () => {
    expect(appendQuote("first thought\n", "> q")).toBe("first thought\n\n> q\n\n");
  });

  it("quote, answer, quote builds a point-by-point reply", () => {
    let box = appendQuote("", "> a");
    box += "answer a";
    box = appendQuote(box, "> b");
    expect(box).toBe("> a\n\nanswer a\n\n> b\n\n");
  });
});

describe("quotableSelection", () => {
  function mount(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }
  function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }
  const textOf = (root: HTMLElement, sel: string) => root.querySelector(sel)!.firstChild!;

  it("part of one bubble is quotable", () => {
    const root = mount('<div data-pv-quote-source><p id="p">hello world</p></div>');
    const sel = select(textOf(root, "#p"), 6, textOf(root, "#p"), 11);
    const q = quotableSelection(sel, root);
    expect(q?.text).toBe("world");
    expect(q?.name).toBeNull();
  });

  it("a room bubble's quote carries its name, without the name header", () => {
    const root = mount(
      '<div data-pv-quote-source data-pv-quote-name="Bilbo"><div id="h" data-pv-no-quote>Bilbo</div><div id="b">ring talk</div></div>',
    );
    const sel = select(textOf(root, "#h"), 0, textOf(root, "#b"), 9);
    const q = quotableSelection(sel, root);
    expect(q?.text).toBe("ring talk\n");
    expect(q?.name).toBe("Bilbo");
  });

  it("a drag that overshoots the bubble edge is clipped back to it", () => {
    const root = mount('<div id="gap">gap</div><div data-pv-quote-source><p id="p">inside</p></div><div id="after">after</div>');
    const sel = select(textOf(root, "#gap"), 1, textOf(root, "#after"), 0);
    expect(quotableSelection(sel, root)?.text).toBe("inside\n\n");
  });

  it("words from two bubbles are not quotable", () => {
    const root = mount(
      '<div data-pv-quote-source><p id="a">first</p></div><div data-pv-quote-source><p id="b">second</p></div>',
    );
    const sel = select(textOf(root, "#a"), 2, textOf(root, "#b"), 3);
    expect(quotableSelection(sel, root)).toBeNull();
  });

  it("a selection only touching the next bubble's edge still counts as one bubble", () => {
    const root = mount(
      '<div data-pv-quote-source><p id="a">first</p></div><div data-pv-quote-source id="b2"><p id="b">second</p></div>',
    );
    const sel = select(textOf(root, "#a"), 0, root.querySelector("#b2")!, 0);
    expect(quotableSelection(sel, root)?.text).toBe("first\n\n");
  });

  it("text outside any bubble, or in another pane, is not quotable", () => {
    const root = mount('<div id="loose">loose text</div>');
    const other = mount('<div data-pv-quote-source><p id="p">other pane</p></div>');
    expect(quotableSelection(select(textOf(root, "#loose"), 0, textOf(root, "#loose"), 5), root)).toBeNull();
    expect(quotableSelection(select(textOf(other, "#p"), 0, textOf(other, "#p"), 5), root)).toBeNull();
  });

  it("selecting only a bubble's buttons is not quotable", () => {
    const root = mount('<div data-pv-quote-source><button id="btn">Speak</button></div>');
    const sel = select(textOf(root, "#btn"), 0, textOf(root, "#btn"), 5);
    expect(quotableSelection(sel, root)).toBeNull();
  });

  it("a selection ending inside a formula takes the whole formula", () => {
    const root = mount(
      '<div data-pv-quote-source><p id="p">so <span class="pv-rich-math" data-pv-quote-tex="$x^2$">' +
        '<span aria-hidden="true"><span id="glyph">x2</span></span><span class="sr-only">x squared</span></span> grows</p></div>',
    );
    const p = root.querySelector("#p")!.firstChild!;
    const glyph = root.querySelector("#glyph")!.firstChild!;
    expect(quotableSelection(select(p, 0, glyph, 1), root)?.text).toBe("so $x^2$");
    expect(quotableSelection(select(glyph, 0, glyph, 1), root)?.text).toBe("$x^2$");
  });

  it("no selection, nothing quotable", () => {
    const root = mount("<div data-pv-quote-source>x</div>");
    expect(quotableSelection(window.getSelection(), root)).toBeNull();
  });
});

describe("quoteButtonPosition", () => {
  const vp = { width: 400, height: 800 };
  const rect = { top: 300, bottom: 340, left: 100, right: 200 };

  it("desktop: above the selection, centred", () => {
    expect(quoteButtonPosition(rect, false, vp)).toEqual({ top: 300 - QUOTE_BUTTON_H - 8, left: 150 - QUOTE_BUTTON_W / 2 });
  });

  it("touch: below the selection, clear of the phone's copy bar", () => {
    expect(quoteButtonPosition(rect, true, vp).top).toBe(370);
  });

  it("desktop near the top: drops below instead", () => {
    expect(quoteButtonPosition({ ...rect, top: 10, bottom: 30 }, false, vp).top).toBe(38);
  });

  it("touch near the bottom: goes above instead", () => {
    expect(quoteButtonPosition({ ...rect, top: 760, bottom: 790 }, true, vp).top).toBe(760 - QUOTE_BUTTON_H - 8);
  });

  it("stays inside the screen sideways", () => {
    expect(quoteButtonPosition({ ...rect, left: 0, right: 10 }, false, vp).left).toBe(8);
    expect(quoteButtonPosition({ ...rect, left: 390, right: 400 }, false, vp).left).toBe(400 - QUOTE_BUTTON_W - 8);
  });
});
