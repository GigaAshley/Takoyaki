// Where a click on the pencil (or a project's / role's "new conversation")
// lands. A fresh new-conversation pane opens and shows the way a
// conversation click does — unless what's on screen already is a lone
// new-conversation pane: then that one is used (the pencil leaves it as it
// is; a project or role switches it to that starting point).

import type { SplitNode } from "./split-tree";
import { findLeaf } from "./split-tree";

export type NewConversationOpenDecision =
  | { kind: "reuse"; tabId: string }
  | { kind: "open" };

export function decideNewConversationOpen(input: {
  /** The tab on screen (the selected one), if any. */
  shown: { id: string; type: string } | undefined;
  splitTree: SplitNode | null;
  /** A phone shows one pane at a time — never a split. */
  isMobile: boolean;
  /** The shown pane's conversation is being created right now: it's left
   *  alone (it becomes that conversation), and a fresh pane opens instead. */
  shownIsStarting?: boolean;
}): NewConversationOpenDecision {
  const { shown, splitTree, isMobile } = input;
  if (shown === undefined || shown.type !== "new-conversation") return { kind: "open" };
  if (input.shownIsStarting) return { kind: "open" };
  // Shown alone: no split, a phone, or laid over a split it isn't part of.
  const alone = isMobile || splitTree === null || findLeaf(splitTree, shown.id) === null;
  return alone ? { kind: "reuse", tabId: shown.id } : { kind: "open" };
}
