/**
 * room-attention-store.test.ts — per-user relay-room marks, run against a
 * real in-memory SQLite with the production DDL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("../database/db/index.js", () => ({
  getSqlite: () => {
    throw new Error("not used in these tests");
  },
}));
vi.mock("../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { triggerSave: vi.fn(), forceSave: vi.fn() },
}));
vi.mock("../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { ATTENTION_TABLES_SQL } from "./attention-schema.js";
import { createRoomAttentionStore, isValidRoomId } from "./room-attention-store.js";

const ROOM = "!garden:hs";
let sqlite: Database.Database;
let save: ReturnType<typeof vi.fn>;
let forceSave: ReturnType<typeof vi.fn>;
const store = () => createRoomAttentionStore({ sqlite: () => sqlite, save, forceSave });

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES ('u1'), ('u2');");
  sqlite.exec(ATTENTION_TABLES_SQL);
  save = vi.fn();
  forceSave = vi.fn();
});

describe("room attention store", () => {
  it("an agent's post lights only the dot; a person's lights the envelope too", () => {
    const s = store();
    expect(s.recordMessage("u1", ROOM, 1000, false)).toEqual({
      roomId: ROOM, lastMessageAt: 1000, seenMessageAt: 0, lastDmAt: 0, seenDmAt: 0,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.recordMessage("u1", ROOM, 2000, true)).toEqual({
      roomId: ROOM, lastMessageAt: 2000, seenMessageAt: 0, lastDmAt: 2000, seenDmAt: 0,
    });
    // A person's post is saved at once.
    expect(forceSave).toHaveBeenCalledTimes(1);
  });

  it("only moves forward", () => {
    const s = store();
    s.recordMessage("u1", ROOM, 2000, true);
    expect(s.recordMessage("u1", ROOM, 1500, true)).toBeNull();
    expect(s.recordMessage("u1", ROOM, 2000, false)).toBeNull();
    // An older person's post still counts when it is newer than the last one.
    s.recordMessage("u1", ROOM, 3000, false);
    expect(s.recordMessage("u1", ROOM, 2500, true)).toMatchObject({ lastMessageAt: 3000, lastDmAt: 2500 });
  });

  it("keeps users apart", () => {
    const s = store();
    s.recordMessage("u1", ROOM, 1000, true);
    expect(s.getForUser("u2")).toEqual([]);
    expect(s.getForUser("u1")).toHaveLength(1);
  });

  it("seen marks advance, never past what was recorded, never backwards", () => {
    const s = store();
    s.recordMessage("u1", ROOM, 2000, true);
    expect(s.markSeen("u1", ROOM, 3000, null)).toBeNull(); // past the post
    expect(s.markSeen("u1", ROOM, 2000, null)).toMatchObject({ seenMessageAt: 2000, seenDmAt: 0 });
    expect(s.markSeen("u1", ROOM, 2000, null)).toBeNull();
    expect(s.markSeen("u1", ROOM, null, 2000)).toMatchObject({ seenMessageAt: 2000, seenDmAt: 2000 });
    expect(s.markSeen("u1", ROOM, 1000, 1000)).toBeNull();
  });

  it("a room with no recorded post can't be marked seen", () => {
    expect(store().markSeen("u1", ROOM, 1000, 1000)).toBeNull();
  });

  it("the user's own post marks everything before it seen", () => {
    const s = store();
    s.recordMessage("u1", ROOM, 1000, true);
    s.recordMessage("u1", ROOM, 1500, false);
    expect(s.markSeenByOwnPost("u1", ROOM, 1200)).toMatchObject({ seenMessageAt: 1200, seenDmAt: 1000 });
    expect(s.markSeenByOwnPost("u1", ROOM, 1600)).toMatchObject({ seenMessageAt: 1500, seenDmAt: 1000 });
    expect(s.markSeenByOwnPost("u1", ROOM, 1700)).toBeNull();
    // A room the user has no marks in is left alone.
    expect(s.markSeenByOwnPost("u1", "!other:hs", 1700)).toBeNull();
    expect(s.getForUser("u1")).toHaveLength(1);
  });

  it("rejects junk input without writing", () => {
    const s = store();
    expect(s.recordMessage("u1", "not-a-room", 1000, true)).toBeNull();
    expect(s.recordMessage("", ROOM, 1000, true)).toBeNull();
    expect(s.recordMessage("u1", ROOM, -1, true)).toBeNull();
    expect(s.recordMessage("u1", ROOM, Number.NaN, true)).toBeNull();
    expect(s.getForUser("u1")).toEqual([]);
    expect(isValidRoomId("!a:b")).toBe(true);
    expect(isValidRoomId("!" + "x".repeat(300) + ":hs")).toBe(false);
  });

  it("survives a restart", () => {
    store().recordMessage("u1", ROOM, 1234, true);
    expect(store().getForUser("u1")).toEqual([
      { roomId: ROOM, lastMessageAt: 1234, seenMessageAt: 0, lastDmAt: 1234, seenDmAt: 0 },
    ]);
  });
});
