/**
 * room-attention-recorder.test.ts — posts in a user's relay rooms reach their
 * open tabs as room marks and (for a person's post) a browser notification.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  systemLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const publishToUser = vi.fn();
vi.mock("../fleet-status/registry-holder.js", () => ({
  getRegistry: () => ({ publishToUser }),
}));
let canNotify = true;
vi.mock("../notifications/notifications-access.js", () => ({
  userCanUseNotifications: () => canNotify,
}));
const store = { recordMessage: vi.fn(), markSeenByOwnPost: vi.fn() };
vi.mock("./room-attention-store.js", () => ({ getRoomAttentionStore: () => store }));

import { publishRoomNotification, recordOwnRoomPost, recordRoomPost } from "./room-attention-recorder.js";

const ENTRY = { roomId: "!r:hs", lastMessageAt: 10, seenMessageAt: 0, lastDmAt: 10, seenDmAt: 0 };

beforeEach(() => {
  publishToUser.mockReset();
  store.recordMessage.mockReset();
  store.markSeenByOwnPost.mockReset();
  canNotify = true;
});

describe("room attention recorder", () => {
  it("a recorded post goes to the user's tabs", () => {
    store.recordMessage.mockReturnValue(ENTRY);
    recordRoomPost("u1", "!r:hs", 10, true);
    expect(store.recordMessage).toHaveBeenCalledWith("u1", "!r:hs", 10, true);
    expect(publishToUser).toHaveBeenCalledWith("u1", { schemaVersion: 1, type: "relay-room-attention-changed", ...ENTRY });
  });

  it("nothing is sent when nothing advanced", () => {
    store.recordMessage.mockReturnValue(null);
    recordRoomPost("u1", "!r:hs", 10, false);
    store.markSeenByOwnPost.mockReturnValue(null);
    recordOwnRoomPost("u1", "!r:hs", 11);
    expect(publishToUser).not.toHaveBeenCalled();
  });

  it("the user's own post sends the cleared marks", () => {
    const seen = { ...ENTRY, seenMessageAt: 10, seenDmAt: 10 };
    store.markSeenByOwnPost.mockReturnValue(seen);
    recordOwnRoomPost("u1", "!r:hs", 11);
    expect(publishToUser).toHaveBeenCalledWith("u1", { schemaVersion: 1, type: "relay-room-attention-changed", ...seen });
  });

  it("a room notification reaches the tabs only with notifications access", () => {
    const n = { notificationId: "$e", roomId: "!r:hs", title: "Robin · Garden", body: "hi" };
    publishRoomNotification("u1", n);
    expect(publishToUser).toHaveBeenCalledWith("u1", { schemaVersion: 1, type: "relay-room-notified", ...n });
    publishToUser.mockReset();
    canNotify = false;
    publishRoomNotification("u1", n);
    expect(publishToUser).not.toHaveBeenCalled();
  });
});
