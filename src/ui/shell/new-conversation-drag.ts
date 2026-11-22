// ─── new-conversation-drag.ts ──────────────────────────────────────────────
// Wire contract for dragging the sidebar's pencil into the content area,
// where it opens a fresh new-conversation pane — at a pane's edge (a split)
// or over a pane's middle (in its place), like dragging a conversation row.
//
// Its own MIME, like the desktop button's: this drag makes a NEW pane every
// time, so it must not read as a pane-handle (badge) drag — that would light
// the drop lane and the sidebar's filing targets. Once the pane exists, its
// pill drags as a badge like every other pane's handle.

export const NEW_CONVERSATION_DRAG_MIME = "application/x-skynet-new-conversation";

export function writeNewConversationDragData(dt: DataTransfer): void {
  dt.setData(NEW_CONVERSATION_DRAG_MIME, "{}");
  dt.effectAllowed = "copy";
}

export function hasNewConversationDragMime(dt: DataTransfer | null | undefined): boolean {
  return !!dt && !!dt.types && Array.from(dt.types).includes(NEW_CONVERSATION_DRAG_MIME);
}
