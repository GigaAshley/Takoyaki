// Relay-room rows carry the same unread dot and envelope as agent
// conversations, and sort with them: notified first, then unread.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/api/user-preferences-api", () => ({
  putPinnedIds: vi.fn().mockResolvedValue([]),
  setIdentityPinned: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/main-axios", () => ({
  authApi: { get: vi.fn(), post: vi.fn().mockResolvedValue({}) },
}));

import {
  __getSnapshotForTest,
  __resetFleetSessionsForTest,
  updateFleetSessions,
  updateOpenTabs,
  type FleetSession,
} from "./conversation-store";
import {
  __resetAttentionForTest,
  applyReadState,
  applyRemoteRoom,
  markSeen,
  RELAY_ROOM_ATTENTION_HOST,
} from "./attention-store";
import type { Tab } from "@/types/ui-types";

function room(roomId: string, title: string, lastActivityAt: string | null = null): FleetSession {
  return {
    hostId: 0,
    hostName: "",
    sessionName: "",
    created: 0,
    role: null,
    kind: "relay-room",
    id: `row-${roomId}`,
    roomId,
    roomTitle: title,
    lastActivityAt,
  };
}

function rowFor(roomId: string) {
  const s = __getSnapshotForTest();
  return [...s.activeSet, ...s.pinned, ...s.middle].find((r) => r.roomId === roomId);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  __resetAttentionForTest();
  __resetFleetSessionsForTest();
  updateOpenTabs([]);
  applyReadState({ baselineAt: 1_000, seen: [] });
});

describe("relay-room unread marks", () => {
  it("someone's post puts the dot on the room's row", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    expect(rowFor("!a:hs")?.unread).toBeUndefined();
    applyRemoteRoom({ roomId: "!a:hs", lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 0, seenDmAt: 0 });
    expect(rowFor("!a:hs")?.unread).toBe(true);
    expect(rowFor("!a:hs")?.dm).toBeUndefined();
  });

  it("a person's post puts the envelope on it", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    applyRemoteRoom({ roomId: "!a:hs", lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 2_000, seenDmAt: 0 });
    expect(rowFor("!a:hs")?.dm).toBe(true);
  });

  it("an open room's row carries the marks too, and looking clears them", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    updateOpenTabs([
      {
        id: "tab-a",
        type: "terminal",
        label: "Plans",
        sessionKind: "relay-room",
        relayRoomId: "!a:hs",
        relayRoomTitle: "Plans",
      } as unknown as Tab,
    ]);
    applyRemoteRoom({ roomId: "!a:hs", lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 2_000, seenDmAt: 0 });
    expect(rowFor("!a:hs")?.dm).toBe(true);
    markSeen(RELAY_ROOM_ATTENTION_HOST, "!a:hs");
    expect(rowFor("!a:hs")?.dm).toBeUndefined();
    expect(rowFor("!a:hs")?.unread).toBeUndefined();
  });

  it("a notified room sorts first, an unread one next, the rest after", () => {
    updateFleetSessions([
      room("!quiet:hs", "Quiet", new Date(9_000).toISOString()),
      room("!unread:hs", "Unread", new Date(1_500).toISOString()),
      room("!dm:hs", "Notified", new Date(1_200).toISOString()),
    ]);
    applyRemoteRoom({ roomId: "!unread:hs", lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 0, seenDmAt: 0 });
    applyRemoteRoom({ roomId: "!dm:hs", lastMessageAt: 1_900, seenMessageAt: 0, lastDmAt: 1_900, seenDmAt: 0 });
    const order = __getSnapshotForTest()
      .middle.filter((r) => r.roomId)
      .map((r) => r.roomId);
    expect(order).toEqual(["!dm:hs", "!unread:hs", "!quiet:hs"]);
  });
});
