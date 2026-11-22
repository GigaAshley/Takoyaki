/**
 * SplitView — pencil drops (NEW_CONVERSATION_DRAG_MIME).
 *
 * Covers: the drag gate accepts the pencil's MIME (dragover claims the drop
 * and paints the preview), an edge drop dispatches
 * onDropNewConversationInTree at that edge, a center drop dispatches
 * onCenterDropNewConversation for the target, and no other drop handler
 * fires for it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, createEvent, cleanup } from "@testing-library/react";
import { SplitView, hasSkynetDragPayload } from "./SplitView";
import type { SplitNode, SplitPath, DropEdge } from "@/lib/split-tree";
import type { Tab } from "@/types/ui-types";
import { NEW_CONVERSATION_DRAG_MIME, writeNewConversationDragData } from "./new-conversation-drag";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/shell/tabUtils", () => ({
  tabIcon: (_type: string) => "ICON",
}));

const tabTarget = {
  id: "target",
  instanceId: "target",
  type: "terminal",
  label: "TargetTab",
  openedAt: 0,
  targetTmuxSession: null,
} as unknown as Tab;
const leaf = (tabId: string): SplitNode => ({ kind: "session", tabId });

const pencilDt = {
  types: [NEW_CONVERSATION_DRAG_MIME] as readonly string[],
  getData: (k: string) => (k === NEW_CONVERSATION_DRAG_MIME ? "{}" : ""),
};

function dispatchAt(kind: "drop" | "dragOver", el: Element, x: number, y: number, dataTransfer: object) {
  const evt = createEvent[kind](el, { dataTransfer });
  Object.defineProperty(evt, "clientX", { value: x, configurable: true });
  Object.defineProperty(evt, "clientY", { value: y, configurable: true });
  fireEvent(el, evt);
}

function paneOuter(container: HTMLElement): HTMLElement {
  let cur: HTMLElement | null = (container.querySelector("[data-tab-id]") as HTMLElement).parentElement;
  while (cur && !cur.className.includes("relative isolate flex flex-col")) cur = cur.parentElement;
  if (!cur) throw new Error("Pane outer div not found");
  cur.getBoundingClientRect = () =>
    ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return cur;
}

function renderView() {
  const edgeSpy = vi.fn<(path: SplitPath, edge: DropEdge) => void>();
  const centerSpy = vi.fn<(target: string) => void>();
  const otherSpy = vi.fn();
  const utils = render(
    <SplitView
      splitTree={leaf("target")}
      tabs={[tabTarget]}
      onDropNewConversationInTree={edgeSpy}
      onCenterDropNewConversation={centerSpy}
      onDropDesktopInTree={otherSpy}
      onCenterDropDesktop={otherSpy}
      onDropFileChipInTree={otherSpy}
      onCenterDropFileChip={otherSpy}
      onDropAppTileInTree={otherSpy}
      onCenterDropAppTile={otherSpy}
      onDropBadgeInTree={otherSpy}
      onCenterDropBadge={otherSpy}
      onCenterDropRow={otherSpy}
    />,
  );
  return { ...utils, edgeSpy, centerSpy, otherSpy };
}

beforeEach(() => {
  cleanup();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("SplitView — pencil drops", () => {
  it("the drag gate accepts the pencil's MIME", () => {
    expect(hasSkynetDragPayload({ types: [NEW_CONVERSATION_DRAG_MIME] } as unknown as DataTransfer)).toBe(true);
  });

  it("the pencil writes only its own MIME, as a copy", () => {
    const data: Record<string, string> = {};
    const fake = {
      setData: (k: string, v: string) => {
        data[k] = v;
      },
      effectAllowed: "",
    } as unknown as DataTransfer;
    writeNewConversationDragData(fake);
    expect(Object.keys(data)).toEqual([NEW_CONVERSATION_DRAG_MIME]);
    expect(fake.effectAllowed).toBe("copy");
  });

  it("dragover with the pencil paints the drop preview", () => {
    const { container, getByTestId } = renderView();
    dispatchAt("dragOver", paneOuter(container), 95, 50, pencilDt);
    expect(getByTestId("pane-drop-preview-overlay")).toBeTruthy();
  });

  it("edge drop opens a fresh pane at that edge", () => {
    const { container, edgeSpy, centerSpy, otherSpy } = renderView();
    dispatchAt("drop", paneOuter(container), 95, 50, pencilDt);
    expect(edgeSpy).toHaveBeenCalledTimes(1);
    expect(edgeSpy).toHaveBeenCalledWith([], "right");
    expect(centerSpy).not.toHaveBeenCalled();
    expect(otherSpy).not.toHaveBeenCalled();
  });

  it("center drop puts a fresh pane in the target's place", () => {
    const { container, edgeSpy, centerSpy, otherSpy } = renderView();
    dispatchAt("drop", paneOuter(container), 50, 50, pencilDt);
    expect(centerSpy).toHaveBeenCalledWith("target");
    expect(edgeSpy).not.toHaveBeenCalled();
    expect(otherSpy).not.toHaveBeenCalled();
  });

  it("every drop is a fresh pane — two drops, two calls", () => {
    const { container, edgeSpy } = renderView();
    dispatchAt("drop", paneOuter(container), 95, 50, pencilDt);
    dispatchAt("drop", paneOuter(container), 5, 50, pencilDt);
    expect(edgeSpy).toHaveBeenCalledTimes(2);
    expect(edgeSpy).toHaveBeenNthCalledWith(2, [], "left");
  });
});
