// Where a search result opens. While a split is up (two or more panes, not
// a phone) it joins the split beside the largest pane — where the pencil's
// new conversation lands — instead of covering the whole arrangement; if
// it's already one of the panes it's just focused. Otherwise it takes over
// the view.

import type { SplitNode, SplitPath } from "./split-tree";
import { findLeaf, splitTargetForOpen } from "./split-tree";

export type SearchResultPlacement =
  | { kind: "alone" }
  | { kind: "focus" }
  | { kind: "join"; path: SplitPath };

export function decideSearchResultPlacement(input: {
  tabId: string;
  splitTree: SplitNode | null;
  /** A phone shows one pane at a time — never a split. */
  isMobile: boolean;
}): SearchResultPlacement {
  const { tabId, splitTree, isMobile } = input;
  if (isMobile || splitTree === null) return { kind: "alone" };
  if (findLeaf(splitTree, tabId) !== null) return { kind: "focus" };
  const path = splitTargetForOpen(splitTree);
  return path === null ? { kind: "alone" } : { kind: "join", path };
}
