/**
 * The words on a relay-room notification: who posted, and in which room.
 *
 *   senderName — the poster's username when they're a user of this app, else
 *                their Matrix id's local part.
 *   roomName   — the room's name as the user's sidebar shows it, else the
 *                room's Matrix name, else null (the title is then just the
 *                poster's name).
 *
 * Never throws: any lookup failure falls back to the next source.
 */
import { getSqlite } from "../database/db/index.js";
import { getRoomName } from "../matrix/matrix-admin-client.js";
import { databaseLogger } from "../utils/logger.js";

function localpart(mxid: string): string {
  const colon = mxid.indexOf(":");
  return mxid.startsWith("@") && colon > 1 ? mxid.slice(1, colon) : mxid;
}

export async function resolveRoomLabel(
  roomId: string,
  senderMxid: string,
  userId: string,
): Promise<{ senderName: string; roomName: string | null }> {
  let senderName = localpart(senderMxid);
  let roomName: string | null = null;
  try {
    const db = getSqlite();
    const person = db
      .prepare("SELECT username FROM users WHERE mxid = ?")
      .get(senderMxid) as { username: string | null } | undefined;
    if (person?.username) senderName = person.username;
    const session = db
      .prepare("SELECT room_title FROM relay_room_sessions WHERE user_id = ? AND room_id = ?")
      .get(userId, roomId) as { room_title: string | null } | undefined;
    if (session?.room_title) roomName = session.room_title;
  } catch (err) {
    databaseLogger.warn("resolveRoomLabel — database lookup failed", {
      operation: "resolve_room_label_db_failed",
      roomId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  if (roomName === null) {
    try {
      const res = await getRoomName(roomId);
      if (res.ok && res.name) roomName = res.name;
    } catch (err) {
      databaseLogger.warn("resolveRoomLabel — room name lookup failed", {
        operation: "resolve_room_label_name_failed",
        roomId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { senderName, roomName };
}
