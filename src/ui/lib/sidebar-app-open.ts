// A sidebar app tile clicked while a split is up (two or more panes, not a
// phone): if that app is already one of the panes, that pane is focused
// instead of opening a second copy. Dragging the tile still opens a copy,
// and app chips in chats keep opening a fresh one.

import type { SplitNode } from "./split-tree";
import { findLeaf, splitTargetForOpen } from "./split-tree";

export function findAppPaneTab<
  T extends { id: string; type: string; app?: { hostId: number; slug: string } },
>(input: {
  tabs: readonly T[];
  splitTree: SplitNode | null;
  isMobile: boolean;
  hostId: number;
  slug: string;
}): T | undefined {
  const { tabs, splitTree, isMobile, hostId, slug } = input;
  if (isMobile || splitTargetForOpen(splitTree) === null) return undefined;
  return tabs.find(
    (t) =>
      t.type === "app" &&
      t.app?.hostId === hostId &&
      t.app.slug === slug &&
      findLeaf(splitTree, t.id) !== null,
  );
}
