// Relay-room rows: faces carried from the session list onto the row, and the
// immediate sidebar updates after Leave / Rename….

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/api/user-preferences-api", () => ({
  putPinnedIds: vi.fn().mockResolvedValue([]),
  setIdentityPinned: vi.fn().mockResolvedValue(undefined),
}));

import {
  __getSnapshotForTest,
  __resetFleetSessionsForTest,
  getFleetSessionsSnapshot,
  removeRelayRoomSession,
  setRelayRoomTitle,
  updateFleetSessions,
  updateOpenTabs,
  type FleetSession,
} from "./conversation-store";
import type { Tab } from "@/types/ui-types";

const FACES = [
  { mxid: "@finch:hs", kind: "agent" as const, name: "finch" },
  { mxid: "@zed_human:hs", kind: "human" as const, name: "zed", userId: "u-zed", avatarPath: null },
];

function room(roomId: string, title: string, extra: Partial<FleetSession> = {}): FleetSession {
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
    ...extra,
  };
}

function allRows() {
  const s = __getSnapshotForTest();
  return [...s.activeSet, ...s.pinned, ...s.middle];
}

beforeEach(() => {
  __resetFleetSessionsForTest();
  updateOpenTabs([]);
});

describe("relay-room rows", () => {
  it("carry the faces and others count from the session list", () => {
    updateFleetSessions([room("!a:hs", "Plans", { roomFaces: FACES, roomOthersCount: 3 })]);
    const row = allRows().find((r) => r.roomId === "!a:hs");
    expect(row?.roomFaces).toEqual(FACES);
    expect(row?.roomOthersCount).toBe(3);
  });

  it("an open room's row carries the faces too", () => {
    updateFleetSessions([room("!a:hs", "Plans", { roomFaces: FACES, roomOthersCount: 2 })]);
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
    const row = allRows().find((r) => r.id === "tab-a");
    expect(row?.roomFaces).toEqual(FACES);
  });

  it("removeRelayRoomSession drops just that room", () => {
    updateFleetSessions([room("!a:hs", "Plans"), room("!b:hs", "Other")]);
    removeRelayRoomSession("!a:hs");
    expect(getFleetSessionsSnapshot().map((s) => s.roomId)).toEqual(["!b:hs"]);
    expect(allRows().some((r) => r.roomId === "!a:hs")).toBe(false);
  });

  it("setRelayRoomTitle shows the new name on the row", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    setRelayRoomTitle("!a:hs", "New plans");
    const row = allRows().find((r) => r.roomId === "!a:hs");
    expect(row?.roomTitle).toBe("New plans");
    expect(row?.label).toBe("New plans");
  });
});
