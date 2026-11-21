/**
 * relay-room-actions.ts — the routes behind a relay room's Leave and
 * Rename… sidebar menu items.
 *
 *   POST /relay-room/:roomId/leave              → { ok: true }
 *   POST /relay-room/:roomId/rename { name }    → { ok: true }
 *                                               | 403 { error: "not_allowed" }
 *
 * Both act as the signed-in user in Matrix (their mxid comes from the users
 * row, never the request). Access gate: the user must have an active row
 * for the room in relay_room_sessions — otherwise 404, the same answer for
 * "no such room" and "not yours" (no existence oracle).
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import {
  leaveRelayRoom,
  MAX_ROOM_NAME_LENGTH,
  renameRelayRoom,
} from "../../relay-sessions/relay-room-actions.js";
import { lookupHumansFromUsersTable } from "../../relay-room-stream/participants-classifier.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

const MATRIX_ROOM_ID_RE = /^![a-zA-Z0-9._=-]+:[a-zA-Z0-9.-]+$/;

async function lookupCallerMxid(userId: string): Promise<string | null> {
  try {
    const rows = (await db
      .select({ mxid: users.mxid })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)) as Array<{ mxid: string | null }>;
    const mxid = rows[0]?.mxid;
    return typeof mxid === "string" && mxid.length > 0 ? mxid : null;
  } catch (err) {
    databaseLogger.warn("relay-room-actions: caller mxid lookup failed", {
      operation: "relay_room_actions_lookup_mxid_failed",
      userId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

function hasActiveRelayRoomSession(userId: string, roomId: string): boolean {
  const row = db.$client
    .prepare(
      `SELECT id FROM relay_room_sessions WHERE user_id = ? AND room_id = ? AND state = 'active'`,
    )
    .get(userId, roomId) as { id?: string } | undefined;
  return row !== undefined && typeof row.id === "string";
}

/** Shared front half: validate the room id, gate access, find the mxid. */
async function resolveCaller(
  req: Request,
  res: Response,
  operation: string,
): Promise<{ userId: string; roomId: string; mxid: string } | null> {
  const userId = (req as AuthenticatedRequest).userId;
  const roomId = String(req.params.roomId ?? "");
  if (!MATRIX_ROOM_ID_RE.test(roomId)) {
    res.status(400).json({ error: "invalid_room_id" });
    return null;
  }
  if (!hasActiveRelayRoomSession(userId, roomId)) {
    databaseLogger.info("relay room action denied", { operation, userId, roomId });
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const mxid = await lookupCallerMxid(userId);
  if (mxid === null) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return { userId, roomId, mxid };
}

router.post("/:roomId/leave", authenticateJWT, async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, "relay_room_leave_denied");
  if (caller === null) return;
  try {
    const result = await leaveRelayRoom(caller.userId, caller.mxid, caller.roomId);
    if (result.ok === false) {
      res.status(502).json({ error: "leave_failed" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    databaseLogger.error("relay room leave threw", err, {
      operation: "relay_room_leave_threw",
      userId: caller.userId,
      roomId: caller.roomId,
    });
    res.status(500).json({ error: "leave_failed" });
  }
});

router.post("/:roomId/rename", authenticateJWT, async (req: Request, res: Response) => {
  const rawName = (req.body as { name?: unknown } | undefined)?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length === 0 || name.length > MAX_ROOM_NAME_LENGTH) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }
  const caller = await resolveCaller(req, res, "relay_room_rename_denied");
  if (caller === null) return;
  try {
    const humans = await lookupHumansFromUsersTable();
    const result = await renameRelayRoom(
      caller.userId,
      caller.mxid,
      caller.roomId,
      name,
      (mxid) => humans.has(mxid),
    );
    if (result.ok === true) {
      res.json({ ok: true });
      return;
    }
    if (result.ok === false && result.reason === "not_allowed") {
      res.status(403).json({ error: "not_allowed" });
      return;
    }
    res.status(502).json({ error: "rename_failed" });
  } catch (err) {
    databaseLogger.error("relay room rename threw", err, {
      operation: "relay_room_rename_threw",
      userId: caller.userId,
      roomId: caller.roomId,
    });
    res.status(500).json({ error: "rename_failed" });
  }
});

export default router;
