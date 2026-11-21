import { describe, it, expect, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/main-axios", () => ({ authApi: api }));

import {
  applyReadState,
  applyRemoteRoom,
  attentionKey,
  isDmd,
  isUnread,
  RELAY_ROOM_ATTENTION_HOST,
  roomAttentionKey,
  loadReadState,
  markSeen,
  publishLastFinishAt,
  __resetAttentionForTest,
} from "./attention-store";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetAttentionForTest();
  api.get.mockReset();
  api.post.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("attention-store", () => {
  it("does not mark anything seen (or POST) before the read state has loaded", () => {
    publishLastFinishAt("1", "ash", 2_000);
    markSeen("1", "ash");
    expect(api.post).not.toHaveBeenCalled();
    applyReadState({ baselineAt: 1_000, seen: [] });
    expect(isUnread("1:ash")).toBe(true);
  });

  it("a seen mark whose save failed is re-sent after the next read-state load", async () => {
    applyReadState({ baselineAt: 1_000, seen: [] });
    publishLastFinishAt("1", "ash", 2_000);
    api.post.mockRejectedValueOnce(new Error("offline"));
    markSeen("1", "ash");
    await flush();
    expect(isUnread("1:ash")).toBe(false);

    api.get.mockResolvedValueOnce({ data: { baselineAt: 1_000, seen: [] } });
    api.post.mockResolvedValueOnce({});
    await loadReadState();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenLastCalledWith("/attention/seen", { hostId: "1", identityName: "ash", seenFinishAt: 2_000 });
    await flush();

    // Synced now: a further load re-sends nothing.
    api.get.mockResolvedValueOnce({ data: { baselineAt: 1_000, seen: [] } });
    await loadReadState();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("a load requested while one is in flight triggers one fresh fetch after it", async () => {
    let resolveFirst!: (v: unknown) => void;
    api.get
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({
        data: { baselineAt: 1_000, seen: [{ hostId: "1", identityName: "ash", seenFinishAt: 2_000 }] },
      });
    publishLastFinishAt("1", "ash", 2_000);
    const first = loadReadState();
    void loadReadState(); // reconnect while the first is in flight
    resolveFirst({ data: { baselineAt: 1_000, seen: [] } });
    await first;
    await flush();
    await flush();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(isUnread("1:ash")).toBe(false);
  });

  it("finish and seen values only move forward", () => {
    applyReadState({ baselineAt: 1_000, seen: [] });
    publishLastFinishAt("1", "ash", 3_000);
    publishLastFinishAt("1", "ash", 2_000);
    applyReadState({ baselineAt: 1_000, seen: [{ hostId: "1", identityName: "ash", seenFinishAt: 2_500 }] });
    expect(isUnread("1:ash")).toBe(true);
    applyReadState({ baselineAt: 1_000, seen: [{ hostId: "1", identityName: "ash", seenFinishAt: 3_000 }] });
    expect(isUnread("1:ash")).toBe(false);
  });
});

describe("attention-store — relay rooms", () => {
  const ROOM = "!garden:hs";
  const k = () => roomAttentionKey(ROOM);

  it("a room is unread / notified from the server's marks, like a conversation", () => {
    applyReadState({
      baselineAt: 1_000,
      seen: [],
      rooms: [{ roomId: ROOM, lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 2_000, seenDmAt: 0 }],
    });
    expect(isUnread(k())).toBe(true);
    expect(isDmd(k())).toBe(true);
  });

  it("an agent's post only marks the room unread", () => {
    applyReadState({ baselineAt: 1_000, seen: [] });
    applyRemoteRoom({ roomId: ROOM, lastMessageAt: 2_000, seenMessageAt: 0, lastDmAt: 0, seenDmAt: 0 });
    expect(isUnread(k())).toBe(true);
    expect(isDmd(k())).toBe(false);
  });

  it("looking at the room clears both, and tells the server through room-seen", () => {
    api.post.mockResolvedValue({});
    applyReadState({ baselineAt: 1_000, seen: [] });
    applyRemoteRoom({ roomId: ROOM, lastMessageAt: 3_000, seenMessageAt: 0, lastDmAt: 2_500, seenDmAt: 0 });
    markSeen(RELAY_ROOM_ATTENTION_HOST, ROOM);
    expect(isUnread(k())).toBe(false);
    expect(isDmd(k())).toBe(false);
    expect(api.post).toHaveBeenCalledWith("/attention/room-seen", { roomId: ROOM, seenDmAt: 2_500 });
    expect(api.post).toHaveBeenCalledWith("/attention/room-seen", { roomId: ROOM, seenMessageAt: 3_000 });
  });

  it("seen on another device (or by the user's own post) clears it here", () => {
    applyReadState({ baselineAt: 1_000, seen: [] });
    applyRemoteRoom({ roomId: ROOM, lastMessageAt: 3_000, seenMessageAt: 0, lastDmAt: 3_000, seenDmAt: 0 });
    applyRemoteRoom({ roomId: ROOM, lastMessageAt: 3_000, seenMessageAt: 3_000, lastDmAt: 3_000, seenDmAt: 3_000 });
    expect(isUnread(k())).toBe(false);
    expect(isDmd(k())).toBe(false);
  });

  it("a room's key never collides with an agent conversation's", () => {
    expect(roomAttentionKey("!a:hs")).not.toBe(attentionKey("1", "!a:hs"));
  });
});
