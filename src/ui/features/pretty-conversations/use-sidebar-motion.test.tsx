import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useSidebarMotion } from "./use-sidebar-motion";

// jsdom has no layout and no Web Animations: rows report their place from a
// test attribute, and animate() is a spy.
const ROW_H = 36;
let animate: ReturnType<typeof vi.fn>;
let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  animate = vi.fn(() => ({ onfinish: null, oncancel: null }));
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const i = Number(this.getAttribute("data-test-index") ?? 0);
    return { top: i * ROW_H, left: 0, width: 200, height: ROW_H, right: 200, bottom: (i + 1) * ROW_H, x: 0, y: i * ROW_H, toJSON() {} } as DOMRect;
  });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes("reduce") && reduceMotion,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

function List({ ids, enabled = true }: { ids: string[]; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSidebarMotion(ref, enabled);
  return (
    <div ref={ref}>
      {ids.map((id, i) => (
        <div key={id} data-conversation-id={id} data-test-index={i}>{id}</div>
      ))}
    </div>
  );
}

const calls = () =>
  animate.mock.calls.map(([frames], i) => {
    const el = animate.mock.contexts[i] as HTMLElement;
    const f = frames as Keyframe[];
    return `${el.getAttribute("data-conversation-id")}:${"transform" in f[0] ? f[0].transform : `opacity ${f[0].opacity}`}`;
  });

describe("useSidebarMotion", () => {
  it("nothing animates on the first paint", () => {
    render(<List ids={["a", "b", "c"]} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("a row that rises slides from its old place; the rows it passed slide down", () => {
    const { rerender } = render(<List ids={["a", "b", "c"]} />);
    rerender(<List ids={["c", "a", "b"]} />);
    expect(calls().sort()).toEqual([
      "a:translate(0px, -36px)",
      "b:translate(0px, -36px)",
      "c:translate(0px, 72px)",
    ]);
  });

  it("an arriving row fades in and the rows below slide down to make room", () => {
    const { rerender } = render(<List ids={["a", "b"]} />);
    rerender(<List ids={["new", "a", "b"]} />);
    expect(calls().sort()).toEqual([
      "a:translate(0px, -36px)",
      "b:translate(0px, -36px)",
      "new:opacity 0",
    ]);
  });

  it("a leaving row fades out where it was while the rows below close the gap", async () => {
    const { rerender, container } = render(<List ids={["a", "gone", "b"]} />);
    rerender(<List ids={["a", "b"]} />);
    await Promise.resolve(); // mutation observer
    await Promise.resolve();
    expect(calls()).toContain("b:translate(0px, 36px)");
    expect(calls()).toContain("gone:opacity 1");
    const ghost = container.querySelector('[data-sidebar-leaving="true"]') as HTMLElement;
    expect(ghost?.getAttribute("data-conversation-id")).toBe("gone");
    expect(ghost.style.top).toBe("36px");
  });

  it("nothing animates while the change is the user's own search", () => {
    const { rerender } = render(<List ids={["a", "b", "c"]} />);
    rerender(<List ids={["c"]} enabled={false} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("with reduce-motion on, changes snap", () => {
    const { rerender } = render(<List ids={["a", "b", "c"]} />);
    reduceMotion = true;
    rerender(<List ids={["c", "a", "b"]} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it("a re-render with nothing moved animates nothing", () => {
    const { rerender } = render(<List ids={["a", "b"]} />);
    rerender(<List ids={["a", "b"]} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
