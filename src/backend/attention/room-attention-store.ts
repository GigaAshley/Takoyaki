/**
 * room-attention-store.ts — per-user "something new" marks for relay rooms.
 *
 * The room counterpart of read-state-store.ts. Per (user, room):
 *
 *   - lastMessageAt / seenMessageAt — the unread dot. lastMessageAt is the
 *     Matrix server time of the newest post by someone other than the user.
 *   - lastDmAt / seenDmAt — the red envelope. lastDmAt is the newest post by
 *     a person (not an agent) other than the user.
 *
 * A room is unread while lastMessageAt > seenMessageAt, and notified while
 * lastDmAt > seenDmAt. Seen values are echoes of the recorded times (from the
 * browser), or the time of the user's own post in the room — all Matrix
 * server times, so clocks never mix.
 *
 * Writes are monotonic and synchronous (better-sqlite3). Persistence goes
 * through the save trigger: immediate for a person's post (rare, and the
 * whole point of the envelope), debounced otherwise.
 */
import type Database from "better-sqlite3";
import { getSqlite } from "../database/db/index.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { databaseLogger } from "../utils/logger.js";

/** Matrix room ids are `!opaque:server`; bounded so the key stays small. */
export const MAX_ROOM_ID_LEN = 255;

export function isValidRoomId(roomId: unknown): roomId is string {
  return (
    typeof roomId === "string" &&
    roomId.length > 1 &&
    roomId.length <= MAX_ROOM_ID_LEN &&
    roomId.startsWith("!") &&
    roomId.includes(":")
  );
}

export interface RoomAttentionEntry {
  roomId: string;
  lastMessageAt: number;
  seenMessageAt: number;
  lastDmAt: number;
  seenDmAt: number;
}

export interface RoomAttentionStore {
  /** Every room with a recorded post for this user. */
  getForUser(userId: string): RoomAttentionEntry[];
  /**
   * Someone else posted in the room (`fromPerson`: a person, not an agent).
   * Returns the row iff anything advanced.
   */
  recordMessage(userId: string, roomId: string, at: number, fromPerson: boolean): RoomAttentionEntry | null;
  /**
   * The user saw the room up to these times (either may be null). Never
   * moves a seen value past what was recorded. Returns the row iff it advanced.
   */
  markSeen(
    userId: string,
    roomId: string,
    seenMessageAt: number | null,
    seenDmAt: number | null,
  ): RoomAttentionEntry | null;
  /**
   * The user posted in the room at `at`: everything up to then is seen.
   * Returns the row iff it advanced.
   */
  markSeenByOwnPost(userId: string, roomId: string, at: number): RoomAttentionEntry | null;
}

function isValidTime(t: unknown): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0;
}

type Row = {
  room_id: string;
  last_message_at: number;
  seen_message_at: number;
  last_dm_at: number;
  seen_dm_at: number;
};

function toEntry(r: Row): RoomAttentionEntry {
  return {
    roomId: r.room_id,
    lastMessageAt: r.last_message_at,
    seenMessageAt: r.seen_message_at,
    lastDmAt: r.last_dm_at,
    seenDmAt: r.seen_dm_at,
  };
}

const COLUMNS = "room_id, last_message_at, seen_message_at, last_dm_at, seen_dm_at";

export function createRoomAttentionStore(deps: {
  sqlite: () => Database.Database;
  save: (reason: string) => Promise<void> | void;
  forceSave: (reason: string) => Promise<void> | void;
}): RoomAttentionStore {
  const fireSave = (fn: (r: string) => Promise<void> | void, reason: string) => {
    const warn = (err: unknown) =>
      databaseLogger.warn("Room-attention save trigger failed", {
        operation: "attention_room_save_failed",
        reason,
        error: err instanceof Error ? err.message : "unknown",
      });
    try {
      void Promise.resolve(fn(reason)).catch(warn);
    } catch (err) {
      warn(err);
    }
  };

  const read = (db: Database.Database, userId: string, roomId: string): RoomAttentionEntry | null => {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM relay_room_attention WHERE user_id = ? AND room_id = ?`)
      .get(userId, roomId) as Row | undefined;
    return row ? toEntry(row) : null;
  };

  const validKey = (userId: unknown, roomId: unknown) =>
    typeof userId === "string" && userId.length > 0 && isValidRoomId(roomId);

  return {
    getForUser(userId) {
      const rows = deps
        .sqlite()
        .prepare(`SELECT ${COLUMNS} FROM relay_room_attention WHERE user_id = ?`)
        .all(userId) as Row[];
      return rows.map(toEntry);
    },

    recordMessage(userId, roomId, at, fromPerson) {
      if (!validKey(userId, roomId) || !isValidTime(at)) return null;
      const db = deps.sqlite();
      const dmAt = fromPerson ? at : 0;
      const result = db
        .prepare(
          `INSERT INTO relay_room_attention (user_id, room_id, last_message_at, last_dm_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, room_id) DO UPDATE SET
             last_message_at = MAX(relay_room_attention.last_message_at, excluded.last_message_at),
             last_dm_at = MAX(relay_room_attention.last_dm_at, excluded.last_dm_at)
           WHERE excluded.last_message_at > relay_room_attention.last_message_at
              OR excluded.last_dm_at > relay_room_attention.last_dm_at`,
        )
        .run(userId, roomId, at, dmAt);
      if (result.changes === 0) return null;
      fireSave(fromPerson ? deps.forceSave : deps.save, "attention-room-message");
      return read(db, userId, roomId);
    },

    markSeen(userId, roomId, seenMessageAt, seenDmAt) {
      if (!validKey(userId, roomId)) return null;
      const m = isValidTime(seenMessageAt) ? seenMessageAt : 0;
      const d = isValidTime(seenDmAt) ? seenDmAt : 0;
      if (m === 0 && d === 0) return null;
      const db = deps.sqlite();
      // Each seen value only moves forward, and never past what was recorded.
      const result = db
        .prepare(
          `UPDATE relay_room_attention SET
             seen_message_at = CASE WHEN ? > seen_message_at AND ? <= last_message_at
                                    THEN ? ELSE seen_message_at END,
             seen_dm_at = CASE WHEN ? > seen_dm_at AND ? <= last_dm_at
                               THEN ? ELSE seen_dm_at END
           WHERE user_id = ? AND room_id = ?
             AND ((? > seen_message_at AND ? <= last_message_at)
               OR (? > seen_dm_at AND ? <= last_dm_at))`,
        )
        .run(m, m, m, d, d, d, userId, roomId, m, m, d, d);
      if (result.changes === 0) return null;
      fireSave(deps.save, "attention-room-seen");
      return read(db, userId, roomId);
    },

    markSeenByOwnPost(userId, roomId, at) {
      if (!validKey(userId, roomId) || !isValidTime(at)) return null;
      const db = deps.sqlite();
      // Everything recorded at or before the user's own post is seen.
      const result = db
        .prepare(
          `UPDATE relay_room_attention SET
             seen_message_at = MAX(seen_message_at, MIN(?, last_message_at)),
             seen_dm_at = MAX(seen_dm_at, MIN(?, last_dm_at))
           WHERE user_id = ? AND room_id = ?
             AND (MIN(?, last_message_at) > seen_message_at OR MIN(?, last_dm_at) > seen_dm_at)`,
        )
        .run(at, at, userId, roomId, at, at);
      if (result.changes === 0) return null;
      fireSave(deps.save, "attention-room-seen-own-post");
      return read(db, userId, roomId);
    },
  };
}

let singleton: RoomAttentionStore | null = null;

export function getRoomAttentionStore(): RoomAttentionStore {
  if (!singleton) {
    singleton = createRoomAttentionStore({
      sqlite: getSqlite,
      save: (reason) => DatabaseSaveTrigger.triggerSave(reason),
      forceSave: (reason) => DatabaseSaveTrigger.forceSave(reason),
    });
  }
  return singleton;
}

export function _setRoomAttentionStoreForTesting(store: RoomAttentionStore | null): void {
  singleton = store;
}
