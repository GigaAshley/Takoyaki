/**
 * relay-room-actions.ts — the routes behind a relay room's Leave and
 * Rename… sidebar menu items, and sending files into the room.
 *
 *   POST /relay-room/:roomId/leave              → { ok: true }
 *   POST /relay-room/:roomId/rename { name }    → { ok: true }
 *                                               | 403 { error: "not_allowed" }
 *
 *   GET  /relay-room/:roomId/upload-limit       → { maxUploadBytes: number | null }
 *   POST /relay-room/:roomId/files?filename=&type=&txnId=
 *        body: the file's bytes (Content-Type: application/x-relay-room-file,
 *        so no app-wide body parser touches it; the real type is `type=`)
 *                                               → { eventId, content }
 *                                               | 413 { error: "too_large" }
 *   GET  /relay-room/:roomId/files/:eventId/status → { ok: true }
 *                                               | 4xx { error: <class> }
 *
 * All act as the signed-in user in Matrix (their mxid comes from the users
 * row, never the request). Access gate: the user must have an active row
 * for the room in relay_room_sessions — otherwise 404, the same answer for
 * "no such room" and "not yours" (no existence oracle).
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import {
  leaveRelayRoom,
  MAX_ROOM_NAME_LENGTH,
  renameRelayRoom,
} from "../../relay-sessions/relay-room-actions.js";
import { lookupHumansFromUsersTable } from "../../relay-room-stream/participants-classifier.js";
import {
  hasActiveRelayRoomSession,
  lookupCallerMxid,
  MATRIX_ROOM_ID_RE,
} from "../../relay-sessions/relay-room-caller.js";
import {
  checkRoomFile,
  getRoomUploadLimit,
  sendRoomFile,
} from "../../relay-sessions/relay-room-files.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

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
  // One line: control characters and runs of whitespace become one space.
  const name =
    typeof rawName === "string"
      ? rawName.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
      : "";
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

// ─── Files ───────────────────────────────────────────────────────────────────

/** Content type the browser sends file bytes under (see header). */
export const RELAY_ROOM_FILE_CONTENT_TYPE = "application/x-relay-room-file";
/** Ceiling when the chat server names no upload limit of its own. */
const UPLOAD_CEILING_BYTES = 1024 * 1024 * 1024;

/** Read the request body, giving up past `maxBytes`. */
function readBody(req: Request, maxBytes: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        done = true;
        req.pause();
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

router.get("/:roomId/upload-limit", authenticateJWT, async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, "relay_room_upload_limit_denied");
  if (caller === null) return;
  const limit = await getRoomUploadLimit(caller.userId, caller.roomId);
  if (limit.ok === false) {
    res.status(limit.status).json({ error: limit.errorClass });
    return;
  }
  res.json({ maxUploadBytes: limit.maxUploadBytes });
});

router.post("/:roomId/files", authenticateJWT, async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, "relay_room_file_send_denied");
  if (caller === null) return;
  const filename = typeof req.query.filename === "string" ? req.query.filename : "";
  const contentType = typeof req.query.type === "string" ? req.query.type : "";
  const txnId = typeof req.query.txnId === "string" ? req.query.txnId : "";
  if (filename.trim().length === 0 || txnId.length === 0) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const limit = await getRoomUploadLimit(caller.userId, caller.roomId);
  const maxBytes =
    limit.ok === true && limit.maxUploadBytes !== null ? limit.maxUploadBytes : UPLOAD_CEILING_BYTES;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.status(413).json({ error: "too_large" });
    return;
  }
  try {
    const bytes = await readBody(req, maxBytes);
    if (bytes === "too_large") {
      res.status(413).json({ error: "too_large" });
      return;
    }
    const result = await sendRoomFile(caller.userId, caller.roomId, {
      bytes,
      filename,
      contentType,
      txnId,
    });
    if (result.ok === false) {
      res.status(result.status).json({ error: result.errorClass });
      return;
    }
    res.json({ eventId: result.sent.eventId, content: result.sent.content });
  } catch (err) {
    databaseLogger.error("relay room file send threw", err, {
      operation: "relay_room_file_send_threw",
      userId: caller.userId,
      roomId: caller.roomId,
    });
    if (!res.headersSent) res.status(500).json({ error: "send_failed" });
  }
});

router.get("/:roomId/files/:eventId/status", authenticateJWT, async (req: Request, res: Response) => {
  const caller = await resolveCaller(req, res, "relay_room_file_status_denied");
  if (caller === null) return;
  const eventId = String(req.params.eventId ?? "");
  const result = await checkRoomFile(caller.userId, { roomId: caller.roomId, eventId });
  if (result.ok === false) {
    res.status(result.status).json({ error: result.errorClass });
    return;
  }
  res.json({ ok: true });
});

export default router;
