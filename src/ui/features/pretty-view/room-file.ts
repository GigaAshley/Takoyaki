/**
 * Files posted in relay rooms.
 *
 * A room's file gets an ordinary Skynet file address under a reserved host
 * segment, `/file/.relay-room/<roomId>/<eventId>/<name>`, so file chips, the
 * file window, file panes and download all work on it unchanged; the server
 * fetches it from the room's chat server, for room members only.
 */

import type { RoomFileRef } from "@/api/claude-session-api";
import { buildSkynetFileUrl } from "./file-url";

/** Host segment of a room file's address (matches the backend's). */
export const RELAY_ROOM_FILE_HOST = ".relay-room";

const MEDIA_MSGTYPES = new Set(["m.image", "m.file", "m.audio", "m.video"]);

export function isRoomFileMsgtype(msgtype: unknown): boolean {
  return typeof msgtype === "string" && MEDIA_MSGTYPES.has(msgtype);
}

export function buildRoomFileUrl(roomId: string, eventId: string, name: string): string {
  const safeName = name.replace(/[/\\]/g, "_") || "file";
  return buildSkynetFileUrl(RELAY_ROOM_FILE_HOST, `/${roomId}/${eventId}/${safeName}`);
}

/** The file a room message carries, or null when it isn't a file post. */
export function roomFileFromContent(
  content: Record<string, unknown>,
  roomId: string,
  eventId: string,
): RoomFileRef | null {
  if (!isRoomFileMsgtype(content.msgtype)) return null;
  const name =
    (typeof content.filename === "string" && content.filename.trim()) ||
    (typeof content.body === "string" && content.body.trim()) ||
    "file";
  const info = (content.info ?? {}) as Record<string, unknown>;
  const hasUrl = typeof content.url === "string" && content.url.startsWith("mxc://");
  const encrypted = !hasUrl && content.file !== undefined;
  return {
    roomId,
    eventId,
    name,
    size: typeof info.size === "number" ? info.size : null,
    mimetype: typeof info.mimetype === "string" ? info.mimetype : null,
    url: hasUrl ? buildRoomFileUrl(roomId, eventId, name) : null,
    ...(hasUrl ? {} : { unavailable: encrypted ? ("encrypted" as const) : ("missing" as const) }),
  };
}
