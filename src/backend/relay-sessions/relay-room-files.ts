/**
 * relay-room-files.ts — files in relay rooms.
 *
 * A room's file has an ordinary Skynet file address, under a reserved host
 * segment that no real machine can use as a file URL host:
 *
 *   /file/.relay-room/<roomId>/<eventId>/<filename>
 *
 * so the chat's file chips, the file window, file panes and download all
 * work on it unchanged. The file routes hand those addresses here.
 *
 * Reading: the user must be active in the room (relay_room_sessions), and
 * the event is read AS the user — the chat server refuses anyone it doesn't
 * let see the room. The bytes come from the event's own `url`, so an address
 * can only ever reach a file that was posted in that room.
 *
 * Sending: upload as the user, then post a file / image / audio / video
 * message as the user — the same message shape agents send.
 */

import { databaseLogger } from "../utils/logger.js";
import {
  getMediaConfigAsUser,
  getRoomEventAsUser,
  openMediaDownloadAsUser,
  parseMxc,
  sendRoomEventAsUser,
  uploadMediaAsUser,
  type RoomMessageEvent,
} from "../matrix/matrix-room-media-client.js";
import { resolveRoomCallerMxid } from "./relay-room-caller.js";

/** Host segment of a room file's address. A leading dot is never a hostname. */
export const RELAY_ROOM_FILE_HOST = ".relay-room";

const MEDIA_MSGTYPES = new Set(["m.image", "m.file", "m.audio", "m.video"]);
const EVENT_ID_RE = /^\$[A-Za-z0-9._~+/=:-]+$/;
const TXN_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;

/** Upload limit cache per user — the server's number rarely changes. */
const LIMIT_TTL_MS = 10 * 60_000;
const limitCache = new Map<string, { value: number | null; at: number }>();

export type RoomFileErrorClass =
  | "not_found" // no such room / not in it / no such event / file gone
  | "not_a_file" // the event isn't a file post
  | "room_file_encrypted" // encrypted attachment — can't be opened here
  | "too_large"
  | "host_unreachable"; // chat server trouble

export type RoomFileFailure = { ok: false; errorClass: RoomFileErrorClass; status: number };

export interface RoomFileAddress {
  roomId: string;
  eventId: string;
}

/** `/<roomId>/<eventId>/<name>` → the room and event; null otherwise. */
export function parseRoomFilePath(absolutePath: string): RoomFileAddress | null {
  const segs = absolutePath.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const [roomId, eventId] = segs;
  if (!EVENT_ID_RE.test(eventId)) return null;
  if (!roomId.startsWith("!")) return null;
  return { roomId, eventId };
}

/** What a room file post says about its file. */
export interface RoomFilePost {
  name: string;
  mimetype: string | null;
  size: number | null;
  mxc: string | null;
  encrypted: boolean;
}

export function describeFilePost(event: RoomMessageEvent): RoomFilePost | null {
  if (event.type !== "m.room.message") return null;
  const c = event.content ?? {};
  if (typeof c.msgtype !== "string" || !MEDIA_MSGTYPES.has(c.msgtype)) return null;
  const name =
    (typeof c.filename === "string" && c.filename.trim()) ||
    (typeof c.body === "string" && c.body.trim()) ||
    "file";
  const info = (c.info ?? {}) as Record<string, unknown>;
  const url = typeof c.url === "string" && parseMxc(c.url) !== null ? c.url : null;
  return {
    name,
    mimetype: typeof info.mimetype === "string" ? info.mimetype : null,
    size: typeof info.size === "number" ? info.size : null,
    mxc: url,
    encrypted: url === null && c.file !== undefined,
  };
}

function fail(errorClass: RoomFileErrorClass): RoomFileFailure {
  const status =
    errorClass === "not_found" ? 404
      : errorClass === "too_large" ? 413
        : errorClass === "host_unreachable" ? 502
          : 422;
  return { ok: false, errorClass, status };
}

/** Find the post behind an address, checking the user may see it. */
async function resolvePost(
  userId: string,
  addr: RoomFileAddress,
): Promise<{ ok: true; mxid: string; post: RoomFilePost } | RoomFileFailure> {
  const mxid = await resolveRoomCallerMxid(userId, addr.roomId);
  if (mxid === null) return fail("not_found");
  const ev = await getRoomEventAsUser(mxid, addr.roomId, addr.eventId);
  if (ev.ok === false) {
    return fail(ev.status === 404 || ev.status === 403 ? "not_found" : "host_unreachable");
  }
  const post = describeFilePost(ev.event);
  if (post === null) return fail("not_a_file");
  if (post.encrypted) return fail("room_file_encrypted");
  if (post.mxc === null) return fail("not_found");
  return { ok: true, mxid, post };
}

/**
 * Open a room file for streaming. Resolves with the chat server's live
 * download (body unread; 200, or 206 for a Range request).
 */
export async function openRoomFile(
  userId: string,
  addr: RoomFileAddress,
  range?: string,
): Promise<{ ok: true; post: RoomFilePost; response: Response } | RoomFileFailure> {
  const found = await resolvePost(userId, addr);
  if (found.ok === false) return found;
  const dl = await openMediaDownloadAsUser(found.mxid, found.post.mxc as string, range);
  if (dl.ok === false) {
    databaseLogger.info("relay room file download refused", {
      operation: "relay_room_file_download_failed",
      userId,
      roomId: addr.roomId,
      eventId: addr.eventId,
      status: dl.status,
    });
    return fail(dl.status === 404 || dl.status === 403 ? "not_found" : "host_unreachable");
  }
  return { ok: true, post: found.post, response: dl.response };
}

/** Read a room file whole, refusing anything over `maxBytes`. */
export async function readRoomFile(
  userId: string,
  addr: RoomFileAddress,
  maxBytes: number,
): Promise<{ ok: true; post: RoomFilePost; bytes: Buffer } | RoomFileFailure> {
  const found = await resolvePost(userId, addr);
  if (found.ok === false) return found;
  if (found.post.size !== null && found.post.size > maxBytes) return fail("too_large");
  const dl = await openMediaDownloadAsUser(found.mxid, found.post.mxc as string);
  if (dl.ok === false) {
    return fail(dl.status === 404 || dl.status === 403 ? "not_found" : "host_unreachable");
  }
  const declared = Number(dl.response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void dl.response.body?.cancel().catch(() => {});
    return fail("too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = dl.response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return fail("too_large");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { ok: true, post: found.post, bytes: Buffer.concat(chunks) };
}

/** Can this room file be opened? (Cheap: the download is opened, not read.) */
export async function checkRoomFile(
  userId: string,
  addr: RoomFileAddress,
): Promise<{ ok: true } | RoomFileFailure> {
  const opened = await openRoomFile(userId, addr, "bytes=0-0");
  if (opened.ok === false) return opened;
  void opened.response.body?.cancel().catch(() => {});
  return { ok: true };
}

/** The chat server's upload limit for this user, or null when it gives none. */
export async function getRoomUploadLimit(
  userId: string,
  roomId: string,
): Promise<{ ok: true; maxUploadBytes: number | null } | RoomFileFailure> {
  const mxid = await resolveRoomCallerMxid(userId, roomId);
  if (mxid === null) return fail("not_found");
  const cached = limitCache.get(mxid);
  if (cached && Date.now() - cached.at < LIMIT_TTL_MS) {
    return { ok: true, maxUploadBytes: cached.value };
  }
  const cfg = await getMediaConfigAsUser(mxid);
  if (cfg.ok === false) return fail("host_unreachable");
  limitCache.set(mxid, { value: cfg.maxUploadBytes, at: Date.now() });
  return { ok: true, maxUploadBytes: cfg.maxUploadBytes };
}

/** Which kind of file post a file becomes, by its type. */
export function msgtypeForMime(mime: string): string {
  const top = mime.split("/")[0];
  return top === "image" ? "m.image" : top === "audio" ? "m.audio" : top === "video" ? "m.video" : "m.file";
}

/** Clean a file name to one safe line. */
export function cleanFileName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim();
  return (name.length > 0 ? name : "file").slice(0, 255);
}

export interface SentRoomFile {
  eventId: string;
  content: Record<string, unknown>;
}

/** Upload `bytes` and post them into the room, as the user. */
export async function sendRoomFile(
  userId: string,
  roomId: string,
  file: { bytes: Buffer; filename: string; contentType: string; txnId: string },
): Promise<{ ok: true; sent: SentRoomFile } | RoomFileFailure | { ok: false; errorClass: "invalid_txn_id"; status: 400 }> {
  if (!TXN_ID_RE.test(file.txnId)) return { ok: false, errorClass: "invalid_txn_id", status: 400 };
  const mxid = await resolveRoomCallerMxid(userId, roomId);
  if (mxid === null) return fail("not_found");
  const limit = await getRoomUploadLimit(userId, roomId);
  if (limit.ok === true && limit.maxUploadBytes !== null && file.bytes.byteLength > limit.maxUploadBytes) {
    return fail("too_large");
  }
  const filename = cleanFileName(file.filename);
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.contentType)
    ? file.contentType.toLowerCase()
    : "application/octet-stream";
  const up = await uploadMediaAsUser(mxid, file.bytes, filename, mime);
  if (up.ok === false) {
    databaseLogger.warn("relay room file upload failed", {
      operation: "relay_room_file_upload_failed",
      userId,
      roomId,
      status: up.status,
      error: up.error,
    });
    return fail(up.status === 413 ? "too_large" : "host_unreachable");
  }
  const content: Record<string, unknown> = {
    msgtype: msgtypeForMime(mime),
    body: filename,
    filename,
    url: up.mxc,
    info: { mimetype: mime, size: file.bytes.byteLength },
  };
  const sent = await sendRoomEventAsUser(mxid, roomId, content, file.txnId);
  if (sent.ok === false) {
    databaseLogger.warn("relay room file post failed", {
      operation: "relay_room_file_post_failed",
      userId,
      roomId,
      status: sent.status,
      error: sent.error,
    });
    return fail(sent.status === 403 || sent.status === 404 ? "not_found" : "host_unreachable");
  }
  databaseLogger.info("relay room file sent", {
    operation: "relay_room_file_sent",
    userId,
    roomId,
    eventId: sent.eventId,
    size: file.bytes.byteLength,
    msgtype: content.msgtype,
  });
  return { ok: true, sent: { eventId: sent.eventId, content } };
}
