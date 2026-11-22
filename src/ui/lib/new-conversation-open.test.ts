/**
 * Where a click on the pencil (or a project's / role's "new conversation")
 * lands: a fresh pane, unless a lone new-conversation pane is already shown.
 */

import { describe, it, expect } from "vitest";
import { decideNewConversationOpen } from "./new-conversation-open";
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

describe("decideNewConversationOpen", () => {
  it("opens a fresh pane when nothing is shown", () => {
    expect(decideNewConversationOpen({ shown: undefined, splitTree: null, isMobile: false })).toEqual({ kind: "open" });
  });

  it("opens a fresh pane over a conversation", () => {
    expect(
      decideNewConversationOpen({ shown: { id: "c", type: "terminal" }, splitTree: null, isMobile: false }),
    ).toEqual({ kind: "open" });
  });

  it("reuses a lone new-conversation pane", () => {
    expect(
      decideNewConversationOpen({ shown: { id: "n", type: "new-conversation" }, splitTree: null, isMobile: false }),
    ).toEqual({ kind: "reuse", tabId: "n" });
  });

  it("reuses one laid over a split it isn't part of (shown alone)", () => {
    expect(
      decideNewConversationOpen({
        shown: { id: "n", type: "new-conversation" },
        splitTree: split("a", "b"),
        isMobile: false,
      }),
    ).toEqual({ kind: "reuse", tabId: "n" });
  });

  it("opens a fresh one when the selected new-conversation pane sits in a split", () => {
    expect(
      decideNewConversationOpen({
        shown: { id: "n", type: "new-conversation" },
        splitTree: split("a", "n"),
        isMobile: false,
      }),
    ).toEqual({ kind: "open" });
  });

  it("on a phone the shown pane is always alone", () => {
    expect(
      decideNewConversationOpen({
        shown: { id: "n", type: "new-conversation" },
        splitTree: split("a", "n"),
        isMobile: true,
      }),
    ).toEqual({ kind: "reuse", tabId: "n" });
  });

  it("a lone pane whose conversation is being created is left alone — a fresh one opens", () => {
    expect(
      decideNewConversationOpen({
        shown: { id: "n", type: "new-conversation" },
        splitTree: null,
        isMobile: false,
        shownIsStarting: true,
      }),
    ).toEqual({ kind: "open" });
  });
});
