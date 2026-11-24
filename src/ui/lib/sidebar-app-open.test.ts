/**
 * A sidebar app tile clicked while a split is up focuses the app's pane
 * when it's already one of the panes, instead of opening a second copy.
 */

import { describe, it, expect } from "vitest";
import { findAppPaneTab } from "./sidebar-app-open";
import type { SplitNode } from "./split-tree";

const split = (a: string, b: string): SplitNode =>
  ({
    kind: "split",
    direction: "vertical",
    children: [
      { kind: "session", tabId: a },
      { kind: "session", tabId: b },
    ],
  }) as unknown as SplitNode;

const tabs = [
  { id: "conv", type: "terminal" },
  { id: "app-1", type: "app", app: { hostId: 1, slug: "notes" } },
  { id: "app-bg", type: "app", app: { hostId: 1, slug: "tracker" } },
];

const find = (over: Partial<Parameters<typeof findAppPaneTab>[0]>) =>
  findAppPaneTab({ tabs, splitTree: split("conv", "app-1"), isMobile: false, hostId: 1, slug: "notes", ...over });

describe("findAppPaneTab", () => {
  it("finds the app's pane in an open split", () => {
    expect(find({})?.id).toBe("app-1");
  });

  it("ignores an open copy that isn't one of the panes", () => {
    expect(find({ slug: "tracker" })).toBeUndefined();
  });

  it("matches the machine as well as the app", () => {
    expect(find({ hostId: 2 })).toBeUndefined();
  });

  it("does nothing with no split or a lone pane left", () => {
    expect(find({ splitTree: null })).toBeUndefined();
    expect(find({ splitTree: { kind: "session", tabId: "app-1" } as unknown as SplitNode })).toBeUndefined();
  });

  it("does nothing on a phone", () => {
    expect(find({ isMobile: true })).toBeUndefined();
  });
});
