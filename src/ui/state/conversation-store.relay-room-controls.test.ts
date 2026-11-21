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

  it("a list that couldn't read a room's members keeps the faces already known", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    updateFleetSessions([room("!a:hs", "Plans", { roomFaces: FACES, roomOthersCount: 3 })]);
    updateFleetSessions([room("!a:hs", "Plans renamed"), room("!b:hs", "New")]);
    const a = allRows().find((r) => r.roomId === "!a:hs");
    expect(a?.roomFaces).toEqual(FACES);
    expect(a?.roomOthersCount).toBe(3);
    expect(allRows().find((r) => r.roomId === "!b:hs")?.roomFaces).toBeUndefined();
    expect(getFleetSessionsSnapshot().find((s) => s.roomId === "!a:hs")?.roomTitle).toBe("Plans renamed");
  });

  it("a room whose members were read fresh takes the new faces", () => {
    updateFleetSessions([room("!a:hs", "Plans", { roomFaces: FACES, roomOthersCount: 3 })]);
    updateFleetSessions([room("!a:hs", "Plans", { roomFaces: [FACES[0]], roomOthersCount: 1 })]);
    expect(allRows().find((r) => r.roomId === "!a:hs")?.roomFaces).toEqual([FACES[0]]);
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

  it("a room tab reopened with its id as its name shows the room's real name", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    updateOpenTabs([
      {
        id: "tab-a",
        type: "terminal",
        label: "!a:hs",
        sessionKind: "relay-room",
        relayRoomId: "!a:hs",
        relayRoomTitle: null,
      } as unknown as Tab,
    ]);
    const row = allRows().find((r) => r.id === "tab-a");
    expect(row?.label).toBe("Plans");
    expect(row?.roomTitle).toBe("Plans");
  });

  it("two open tabs of one room still make one row", () => {
    updateFleetSessions([room("!a:hs", "Plans")]);
    const tab = (id: string) =>
      ({
        id,
        type: "terminal",
        label: "Plans",
        sessionKind: "relay-room",
        relayRoomId: "!a:hs",
        relayRoomTitle: "Plans",
      }) as unknown as Tab;
    updateOpenTabs([tab("tab-1"), tab("tab-2")]);
    const rows = allRows().filter((r) => r.roomId === "!a:hs");
    expect(rows.map((r) => r.id)).toEqual(["tab-1"]);
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
