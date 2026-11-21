// relay-room-files-api.ts — files in a relay room, as the signed-in user
// (backend: src/backend/database/routes/relay-room-actions.ts).

import axios from "axios";
import { authApi } from "@/main-axios";

/** Content type file bytes travel under; the real type rides in `type=`. */
const FILE_BODY_CONTENT_TYPE = "application/x-relay-room-file";

/** Long enough for a big file on a slow connection. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** The room's chat-server upload limit in bytes, or null when it names none. */
export async function getRelayRoomUploadLimit(roomId: string): Promise<number | null> {
  const res = await authApi.get(`/relay-room/${encodeURIComponent(roomId)}/upload-limit`);
  const v = (res.data as { maxUploadBytes?: unknown } | undefined)?.maxUploadBytes;
  return typeof v === "number" && v > 0 ? v : null;
}

export interface SentRelayRoomFile {
  eventId: string;
  content: Record<string, unknown>;
}

export class RelayRoomFileSendError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "RelayRoomFileSendError";
  }
}

/** Upload `file` and post it into the room. Throws RelayRoomFileSendError. */
export async function sendRelayRoomFile(
  roomId: string,
  file: File,
  txnId: string,
): Promise<SentRelayRoomFile> {
  const params = new URLSearchParams({
    filename: file.name,
    type: file.type || "application/octet-stream",
    txnId,
  });
  try {
    const res = await authApi.post(
      `/relay-room/${encodeURIComponent(roomId)}/files?${params.toString()}`,
      file,
      {
        headers: { "Content-Type": FILE_BODY_CONTENT_TYPE },
        timeout: UPLOAD_TIMEOUT_MS,
        // The bytes go as they are.
        transformRequest: [(data: unknown) => data],
      },
    );
    const data = res.data as { eventId?: unknown; content?: unknown };
    if (typeof data.eventId !== "string" || data.content === null || typeof data.content !== "object") {
      throw new RelayRoomFileSendError("malformed_response");
    }
    return { eventId: data.eventId, content: data.content as Record<string, unknown> };
  } catch (err) {
    if (err instanceof RelayRoomFileSendError) throw err;
    if (axios.isAxiosError(err)) {
      const code = (err.response?.data as { error?: unknown } | undefined)?.error;
      throw new RelayRoomFileSendError(typeof code === "string" ? code : err.code ?? "network_error");
    }
    throw new RelayRoomFileSendError("unknown");
  }
}

/**
 * Can a posted room file be opened? "ok", or why not: "not_found" (gone from
 * the chat server), "room_file_encrypted", "not_a_file". "unknown" when the
 * check itself couldn't run — callers then treat the file as openable.
 */
export async function getRelayRoomFileStatus(roomId: string, eventId: string): Promise<string> {
  try {
    await authApi.get(
      `/relay-room/${encodeURIComponent(roomId)}/files/${encodeURIComponent(eventId)}/status`,
    );
    return "ok";
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const code = (err.response.data as { error?: unknown } | undefined)?.error;
      if (code === "not_found" || code === "room_file_encrypted" || code === "not_a_file") return code;
    }
    return "unknown";
  }
}
