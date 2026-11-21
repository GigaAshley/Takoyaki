import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { kit, api, store } = vi.hoisted(() => ({
  kit: { kitConfirm: vi.fn(), kitPrompt: vi.fn(), kitAlert: vi.fn() },
  api: { leaveRelayRoom: vi.fn(), renameRelayRoom: vi.fn() },
  store: { removeRelayRoomSession: vi.fn(), setRelayRoomTitle: vi.fn() },
}));
vi.mock("@/components/kit", () => kit);
vi.mock("@/api/relay-room-actions-api", () => api);
vi.mock("@/state/conversation-store", () => store);

import {
  confirmAndLeaveRelayRoom,
  promptAndRenameRelayRoom,
  RELAY_ROOM_LEFT_EVENT,
} from "./relay-room-row-actions";

const flush = () => new Promise((r) => setTimeout(r, 0));

let leftEvents: string[] = [];
const onLeft = (e: Event) => leftEvents.push((e as CustomEvent<{ roomId: string }>).detail.roomId);

beforeEach(() => {
  for (const f of [...Object.values(kit), ...Object.values(api), ...Object.values(store)]) f.mockReset();
  leftEvents = [];
  window.addEventListener(RELAY_ROOM_LEFT_EVENT, onLeft);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  window.removeEventListener(RELAY_ROOM_LEFT_EVENT, onLeft);
  vi.restoreAllMocks();
});

describe("Leave", () => {
  it("asks first; on yes leaves, drops the row and closes its panes", async () => {
    kit.kitConfirm.mockResolvedValue(true);
    api.leaveRelayRoom.mockResolvedValue(undefined);
    confirmAndLeaveRelayRoom({ roomId: "!r:hs", title: "Plans" });
    await flush();
    expect(kit.kitConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Leave "Plans"?', confirmLabel: "Leave", destructive: true }),
    );
    expect(api.leaveRelayRoom).toHaveBeenCalledWith("!r:hs");
    expect(store.removeRelayRoomSession).toHaveBeenCalledWith("!r:hs");
    expect(leftEvents).toEqual(["!r:hs"]);
  });

  it("cancel does nothing", async () => {
    kit.kitConfirm.mockResolvedValue(false);
    confirmAndLeaveRelayRoom({ roomId: "!r:hs", title: "Plans" });
    await flush();
    expect(api.leaveRelayRoom).not.toHaveBeenCalled();
    expect(leftEvents).toEqual([]);
  });

  it("a failed leave keeps the room and says so", async () => {
    kit.kitConfirm.mockResolvedValue(true);
    api.leaveRelayRoom.mockRejectedValue(new Error("boom"));
    confirmAndLeaveRelayRoom({ roomId: "!r:hs", title: "Plans" });
    await flush();
    expect(store.removeRelayRoomSession).not.toHaveBeenCalled();
    expect(leftEvents).toEqual([]);
    expect(kit.kitAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't leave the room" }));
  });
});

describe("Rename…", () => {
  it("prefills the current name and shows the new one at once", async () => {
    kit.kitPrompt.mockResolvedValue("  New plans ");
    api.renameRelayRoom.mockResolvedValue("renamed");
    promptAndRenameRelayRoom({ roomId: "!r:hs", currentTitle: "Plans" });
    await flush();
    expect(kit.kitPrompt).toHaveBeenCalledWith(expect.objectContaining({ title: "Rename room", defaultValue: "Plans" }));
    expect(api.renameRelayRoom).toHaveBeenCalledWith("!r:hs", "New plans");
    expect(store.setRelayRoomTitle).toHaveBeenCalledWith("!r:hs", "New plans");
  });

  it("not allowed → a plain message, name unchanged", async () => {
    kit.kitPrompt.mockResolvedValue("New plans");
    api.renameRelayRoom.mockResolvedValue("not_allowed");
    promptAndRenameRelayRoom({ roomId: "!r:hs", currentTitle: "Plans" });
    await flush();
    expect(store.setRelayRoomTitle).not.toHaveBeenCalled();
    expect(kit.kitAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "You can't rename this room" }));
  });

  it("same name or cancel sends nothing", async () => {
    kit.kitPrompt.mockResolvedValueOnce("Plans").mockResolvedValueOnce(null);
    promptAndRenameRelayRoom({ roomId: "!r:hs", currentTitle: "Plans" });
    promptAndRenameRelayRoom({ roomId: "!r:hs", currentTitle: "Plans" });
    await flush();
    expect(api.renameRelayRoom).not.toHaveBeenCalled();
  });
});
