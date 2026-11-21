/**
 * relay-room-caller.ts — who is acting in a relay room, and may they?
 *
 * Shared by every route that acts in a room on a signed-in user's behalf
 * (Leave, Rename…, files). The access gate is an active row for the room in
 * relay_room_sessions; the user's mxid always comes from the users row,
 * never from the request.
 */

import { eq } from "drizzle-orm";
import { db } from "../database/db/index.js";
import { users } from "../database/db/schema.js";
import { databaseLogger } from "../utils/logger.js";

export const MATRIX_ROOM_ID_RE = /^![a-zA-Z0-9._=-]+:[a-zA-Z0-9.-]+$/;

export async function lookupCallerMxid(userId: string): Promise<string | null> {
  try {
    const rows = (await db
      .select({ mxid: users.mxid })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)) as Array<{ mxid: string | null }>;
    const mxid = rows[0]?.mxid;
    return typeof mxid === "string" && mxid.length > 0 ? mxid : null;
  } catch (err) {
    databaseLogger.warn("relay room caller: mxid lookup failed", {
      operation: "relay_room_lookup_mxid_failed",
      userId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

export function hasActiveRelayRoomSession(userId: string, roomId: string): boolean {
  const row = db.$client
    .prepare(
      `SELECT id FROM relay_room_sessions WHERE user_id = ? AND room_id = ? AND state = 'active'`,
    )
    .get(userId, roomId) as { id?: string } | undefined;
  return row !== undefined && typeof row.id === "string";
}

/**
 * The caller's mxid when `roomId` is well formed and the user is active in
 * it; null otherwise ("no such room" and "not yours" look the same).
 */
export async function resolveRoomCallerMxid(
  userId: string,
  roomId: string,
): Promise<string | null> {
  if (!MATRIX_ROOM_ID_RE.test(roomId)) return null;
  if (!hasActiveRelayRoomSession(userId, roomId)) return null;
  return lookupCallerMxid(userId);
}
