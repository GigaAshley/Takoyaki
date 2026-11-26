import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { linkifyText } from "./linkify-text";

function hrefs(text: string): string[] {
  const { container } = render(<div>{linkifyText(text)}</div>);
  return [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

function textOf(text: string): string {
  const { container } = render(<div>{linkifyText(text)}</div>);
  return container.textContent ?? "";
}

describe("linkifyText", () => {
  it("plain text with no address stays one text run", () => {
    expect(linkifyText("hello there")).toEqual(["hello there"]);
    expect(hrefs("hello there")).toEqual([]);
  });

  it("links http and https addresses, several per message", () => {
    expect(hrefs("a http://x.test/1 b https://y.test/2?q=1#h c")).toEqual([
      "http://x.test/1",
      "https://y.test/2?q=1#h",
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(hrefs("go to https://x.test/a.")).toEqual(["https://x.test/a"]);
    expect(hrefs("is it https://x.test/a?")).toEqual(["https://x.test/a"]);
    expect(textOf("go to https://x.test/a.")).toBe("go to https://x.test/a.");
  });

  it("drops an unbalanced closing bracket but keeps balanced ones", () => {
    expect(hrefs("(see https://x.test/a)")).toEqual(["https://x.test/a"]);
    expect(hrefs("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("ignores non-web schemes and a bare scheme", () => {
    expect(hrefs("javascript:alert(1) https:// ftp://x.test")).toEqual([]);
  });

  it("keeps line breaks and surrounding text intact", () => {
    expect(textOf("one\nhttps://x.test\ntwo")).toBe("one\nhttps://x.test\ntwo");
  });
});
