// Pinned relay rooms: a room the user has pinned (the favourite tag on their
// own account) shows in Pinned, once, however many tabs of it are open.
// Pinned and in a project are exclusive; a room somehow in both shows in its
// project.

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
  __resetProjectsForTest,
  applyRoomPlacement,
  mergeRoomPlacementsFromServer,
  patchRoomPinned,
  patchRoomProjectAssignment,
  pinConversation,
  unpinConversation,
  readProjectsCache,
  roomPlacementMark,
  setProjects,
  setRoomPinnedIds,
  setRoomProjectAssignments,
  updateFleetSessions,
  updateOpenTabs,
  type FleetSession,
} from "./conversation-store";
import type { Tab } from "@/types/ui-types";

function room(roomId: string, title: string): FleetSession {
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
    lastActivityAt: null,
  };
}

function roomTab(id: string, roomId: string, title: string): Tab {
  return {
    id,
    type: "terminal",
    label: title,
    sessionKind: "relay-room",
    relayRoomId: roomId,
    relayRoomTitle: title,
  } as unknown as Tab;
}

function where(roomId: string): string[] {
  const s = __getSnapshotForTest();
  const out: string[] = [];
  for (const r of s.pinnedUnassigned) if (r.roomId === roomId) out.push("pinned");
  for (const sec of s.projectSections) {
    for (const r of sec.rows) if (r.roomId === roomId) out.push(`project:${sec.slug}`);
  }
  for (const r of s.middle) if (r.roomId === roomId) out.push("conversations");
  return out;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  __resetFleetSessionsForTest();
  __resetProjectsForTest();
  updateOpenTabs([]);
  setProjects([
    { slug: "alpha", displayName: "Alpha", hostId: "1", hostname: "harbor", archived: false, parent: null },
  ]);
});

describe("pinning relay rooms", () => {
  it("a pinned room shows in Pinned and nowhere else", () => {
    updateFleetSessions([room("!a:hs", "Plans"), room("!b:hs", "Other")]);
    setRoomPinnedIds(["!a:hs"]);
    expect(where("!a:hs")).toEqual(["pinned"]);
    expect(where("!b:hs")).toEqual(["conversations"]);
  });

  it("an open room that's pinned shows once in Pinned, however many tabs are open", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    updateOpenTabs([roomTab("tab-1", "!a:hs", "Plans"), roomTab("tab-2", "!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    expect(where("!a:hs")).toEqual(["pinned"]);
  });

  it("a room both favourited and in a project shows in its project", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    setRoomProjectAssignments(new Map([["!a:hs", "alpha"]]));
    expect(where("!a:hs")).toEqual(["project:alpha"]);
  });

  it("pinning a room in a project takes it out of the project; rollback puts it back", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomProjectAssignments(new Map([["!a:hs", "alpha"]]));
    const rollback = patchRoomPinned("!a:hs", true);
    expect(where("!a:hs")).toEqual(["pinned"]);
    rollback();
    expect(where("!a:hs")).toEqual(["project:alpha"]);
  });

  it("unpinning puts the room back in Conversations", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    patchRoomPinned("!a:hs", false);
    expect(where("!a:hs")).toEqual(["conversations"]);
  });

  it("filing a pinned room into a project unpins it; rollback re-pins it", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    const rollback = patchRoomProjectAssignment("!a:hs", "alpha");
    expect(where("!a:hs")).toEqual(["project:alpha"]);
    rollback();
    expect(where("!a:hs")).toEqual(["pinned"]);
  });

  it("Remove from project on a room that somehow also carries the pin lands it in Conversations", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    setRoomProjectAssignments(new Map([["!a:hs", "alpha"]]));
    patchRoomProjectAssignment("!a:hs", null);
    expect(where("!a:hs")).toEqual(["conversations"]);
  });

  it("a server reload doesn't undo a room moved while it ran, nor forget a room it couldn't read", () => {
    updateFleetSessions([room("!a:hs", "Plans"), room("!b:hs", "Other"), room("!c:hs", "Third")]);
    setRoomPinnedIds(["!b:hs"]);
    const mark = roomPlacementMark();
    patchRoomPinned("!a:hs", true); // moved after the reload started
    mergeRoomPlacementsFromServer({
      mark,
      assignments: new Map([["!c:hs", "alpha"]]),
      pinned: new Set<string>(),
      unknown: new Set(["!b:hs"]),
    });
    expect(where("!a:hs")).toEqual(["pinned"]); // kept: moved after the mark
    expect(where("!b:hs")).toEqual(["pinned"]); // kept: couldn't be read
    expect(where("!c:hs")).toEqual(["project:alpha"]); // taken from the server
  });

  it("a server reload replaces what it did read", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRoomPinnedIds(["!a:hs"]);
    mergeRoomPlacementsFromServer({
      mark: roomPlacementMark(),
      assignments: new Map(),
      pinned: new Set<string>(),
      unknown: new Set<string>(),
    });
    expect(where("!a:hs")).toEqual(["conversations"]);
  });

  it("a superseded rollback does nothing (a newer move wins)", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    const rollback = patchRoomPinned("!a:hs", true);
    patchRoomProjectAssignment("!a:hs", "alpha");
    rollback();
    expect(where("!a:hs")).toEqual(["project:alpha"]);
  });

  it("a move made on another tab or device lands here", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    applyRoomPlacement("!a:hs", null, true);
    expect(where("!a:hs")).toEqual(["pinned"]);
    applyRoomPlacement("!a:hs", "alpha", false);
    expect(where("!a:hs")).toEqual(["project:alpha"]);
    applyRoomPlacement("!a:hs", null, false);
    expect(where("!a:hs")).toEqual(["conversations"]);
  });

  it("pins survive a reload (kept with the project cache)", () => {
    // User-scoped caches only write for a signed-in user.
    localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "test-user" }));
    setRoomPinnedIds(["!a:hs"]);
    expect([...readProjectsCache().roomPinnedIds]).toEqual(["!a:hs"]);
  });

  it("Pinned sorts rooms and agents together by name", () => {
    updateFleetSessions([
      room("!z:hs", "Zeta"),
      room("!a:hs", "Alpha room"),
      {
        hostId: 1,
        hostName: "harbor",
        sessionName: "finch",
        created: 0,
        role: "helper",
      },
    ]);
    setRoomPinnedIds(["!z:hs", "!a:hs"]);
    pinConversation("fleet::1::finch");
    const pinned = __getSnapshotForTest().pinned;
    expect(pinned.map((r) => r.roomId ?? r.id)).toEqual(["!a:hs", "fleet::1::finch", "!z:hs"]);
    unpinConversation("fleet::1::finch");
  });
});
