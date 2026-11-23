/**
 * Where a search result opens: into the split beside the largest pane while
 * two or more panes are up, focused if already one of them, else alone.
 */

import { describe, it, expect } from "vitest";
import { decideSearchResultPlacement, findOpenResultTab } from "./search-result-open";
import { findLargestLeafPath, type SplitNode } from "./split-tree";

const split = (a: string, b: string): SplitNode =>
  ({
    kind: "split",
    direction: "vertical",
    children: [
      { kind: "session", tabId: a },
      { kind: "session", tabId: b },
    ],
  }) as unknown as SplitNode;

describe("decideSearchResultPlacement", () => {
  it("takes over the view when there's no split", () => {
    expect(decideSearchResultPlacement({ tabId: "r", splitTree: null, isMobile: false })).toEqual({ kind: "alone" });
  });

  it("takes over the view when only a lone pane is left", () => {
    const lone = { kind: "session", tabId: "a" } as unknown as SplitNode;
    expect(decideSearchResultPlacement({ tabId: "r", splitTree: lone, isMobile: false })).toEqual({ kind: "alone" });
  });

  it("joins a split beside its largest pane, the pencil's spot", () => {
    const tree = split("a", "b");
    expect(decideSearchResultPlacement({ tabId: "r", splitTree: tree, isMobile: false })).toEqual({
      kind: "join",
      path: findLargestLeafPath(tree),
    });
  });

  it("just focuses a result that's already one of the panes", () => {
    expect(decideSearchResultPlacement({ tabId: "b", splitTree: split("a", "b"), isMobile: false })).toEqual({
      kind: "focus",
    });
  });

  it("never splits on a phone", () => {
    expect(decideSearchResultPlacement({ tabId: "r", splitTree: split("a", "b"), isMobile: true })).toEqual({
      kind: "alone",
    });
  });
});

describe("findOpenResultTab", () => {
  const tabs = [
    { id: "t1", type: "terminal", host: { id: "1" }, targetTmuxSession: "bob" },
    { id: "t2", type: "terminal", host: { id: "1" }, targetTmuxSession: "eve", sessionKind: "archived" },
    { id: "t3", type: "terminal", host: { id: "2" }, targetTmuxSession: "bob", sessionKind: "harness" },
    { id: "t4", type: "app", host: { id: "1" }, targetTmuxSession: "bob" },
  ];

  it("finds the live conversation on the result's host, case ignored", () => {
    expect(findOpenResultTab(tabs, "1", "Bob", false)?.id).toBe("t1");
    expect(findOpenResultTab(tabs, "2", "bob", false)?.id).toBe("t3");
  });

  it("finds the archived view for an archived result, not a live tab", () => {
    expect(findOpenResultTab(tabs, "1", "eve", true)?.id).toBe("t2");
    expect(findOpenResultTab(tabs, "1", "bob", true)).toBeUndefined();
    expect(findOpenResultTab(tabs, "1", "eve", false)).toBeUndefined();
  });

  it("finds nothing on another host", () => {
    expect(findOpenResultTab(tabs, "3", "bob", false)).toBeUndefined();
  });
});
