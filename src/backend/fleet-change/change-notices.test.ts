/**
 * change-notices.test.ts — a person has each machine notice once: told directly when their
 * device got the outcome, dismissed, or claimed by one device for a pop-up; held back while
 * the server is still waiting on the request for them.
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

import { CHANGE_NOTICE_TABLES_SQL } from "./change-notices-schema.js";
import {
  beginAsking,
  createChangeNoticeStore,
  dismissNotice,
  isBeingAsked,
  setChangeNoticeStoreForTests,
  setNoticeRefan,
  toldDirectly,
  untellIfUndelivered,
  type ChangeNoticeStore,
} from "./change-notices.js";

let sqlite: Database.Database;
let now: number;
let store: ChangeNoticeStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES ('u1'), ('u2');");
  sqlite.exec(CHANGE_NOTICE_TABLES_SQL);
  now = 1_000_000_000_000;
  store = createChangeNoticeStore({ sqlite: () => sqlite, now: () => now, save: vi.fn() });
  setChangeNoticeStoreForTests(store);
  setNoticeRefan(null);
});

describe("change notices", () => {
  it("the first claim wins, per person", () => {
    expect(store.markSeen("u1", "7", "req-1")).toBe(true);
    expect(store.markSeen("u1", "7", "req-1")).toBe(false);
    expect(store.isSeen("u1", "7", "req-1")).toBe(true);
    expect(store.isSeen("u2", "7", "req-1")).toBe(false);
    expect(store.isSeen("u1", "8", "req-1")).toBe(false);
  });

  it("a stuck notice is its own key", () => {
    store.markSeen("u1", "7", "req-1");
    expect(store.isSeen("u1", "7", "req-1:stuck")).toBe(false);
  });

  it("refuses odd keys", () => {
    expect(store.markSeen("u1", "7", "../x")).toBe(false);
  });

  it("forgets after two days", () => {
    store.markSeen("u1", "7", "old");
    now += 2 * 24 * 3600 * 1000 + 3600 * 1000 + 1;
    store.markSeen("u1", "7", "new");
    expect(store.isSeen("u1", "7", "old")).toBe(false);
    expect(store.isSeen("u1", "7", "new")).toBe(true);
  });

  it("a stuck archive's 'had it' outlives the two days — it never pops up again while still stuck", () => {
    store.markSeen("u1", "7", "a1:stuck");
    store.markSeen("u1", "7", "old");
    now += 3 * 24 * 3600 * 1000;
    store.markSeen("u1", "7", "trigger-prune");
    expect(store.isSeen("u1", "7", "a1:stuck")).toBe(true);
    expect(store.isSeen("u1", "7", "old")).toBe(false);
  });

  it("an answer that never reached them is taken back, and their devices are sent the list again", () => {
    const refan = vi.fn();
    setNoticeRefan(refan);
    const outcome = { state: "refused", id: "r9" };
    toldDirectly("u1", 7, outcome);
    const handlers: Array<() => void> = [];
    const res = { writableFinished: false, on: (_e: "close", fn: () => void) => handlers.push(fn) };
    untellIfUndelivered(res, "u1", 7, outcome);
    handlers.forEach((h) => h());
    expect(store.isSeen("u1", "7", "r9")).toBe(false);
    expect(refan).toHaveBeenCalledWith("7");
  });

  it("an answer that was sent stays told", () => {
    const outcome = { state: "failed", id: "r8" };
    toldDirectly("u1", 7, outcome);
    const handlers: Array<() => void> = [];
    untellIfUndelivered({ writableFinished: true, on: (_e, fn) => handlers.push(fn) }, "u1", 7, outcome);
    handlers.forEach((h) => h());
    expect(store.isSeen("u1", "7", "r8")).toBe(true);
  });

  it("an outcome handed to the asker counts as told — refusals, failures, a new agent left out", () => {
    toldDirectly("u1", 7, { state: "refused", id: "a" });
    toldDirectly("u1", 7, { state: "failed", id: "b" });
    toldDirectly("u1", 7, { state: "done", id: "c", result: { notFiled: "that project is gone" } });
    toldDirectly("u1", 7, { state: "done", id: "d", result: { project: "garden" } });
    toldDirectly(undefined, 7, { state: "refused", id: "e" });
    expect(["a", "b", "c", "d", "e"].map((k) => store.isSeen("u1", "7", k))).toEqual([true, true, true, false, false]);
  });

  it("knows what the server is waiting on, and sends the host again when it stops", () => {
    const refan = vi.fn();
    setNoticeRefan(refan);
    const one = beginAsking(7, "r1");
    const two = beginAsking(7, "r1");
    expect(isBeingAsked("7", "r1")).toBe(true);
    one();
    one();
    expect(isBeingAsked(7, "r1")).toBe(true);
    expect(refan).not.toHaveBeenCalled();
    two();
    expect(isBeingAsked(7, "r1")).toBe(false);
    expect(refan).toHaveBeenCalledWith("7");
  });

  it("a dismissal sends the host again only the first time", () => {
    const refan = vi.fn();
    setNoticeRefan(refan);
    expect(dismissNotice("u1", 7, "r1")).toBe(true);
    expect(dismissNotice("u1", 7, "r1")).toBe(false);
    expect(refan).toHaveBeenCalledTimes(1);
  });
});
