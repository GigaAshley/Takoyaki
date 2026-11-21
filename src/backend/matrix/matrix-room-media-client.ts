// matrix-room-media-client — the Matrix calls behind files in relay rooms:
// the upload limit, uploading a file, posting it into the room, reading one
// event, and fetching a file's bytes.
//
// Every call runs as the USER with their cached token (ensureUserToken),
// retrying once with a fresh token on 401 — so the chat server itself
// decides what the user may see and post. Never logs a token or file bytes.

import { databaseLogger } from "../utils/logger.js";
import { getMatrixAdminCreds } from "./matrix-admin-creds-store.js";
import { ensureUserToken, evictUserToken } from "./matrix-admin-client.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** Uploads and downloads move real bytes; give them longer. */
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

const ERR_CREDS_MISSING = "matrix_admin_creds_missing";
const ERR_NON_2XX = "matrix_media_non_2xx";
const ERR_TIMEOUT = "matrix_media_timeout";
const ERR_PROXY = "matrix_media_proxy_error";
const ERR_MALFORMED = "matrix_media_malformed_response";

export type MediaErr = { ok: false; status: number; error: string };

const MXC_RE = /^mxc:\/\/([^/]+)\/([^/?#]+)$/;

/** Split `mxc://server/id`; null when it isn't one. */
export function parseMxc(mxc: string): { server: string; mediaId: string } | null {
  const m = MXC_RE.exec(mxc);
  return m ? { server: m[1], mediaId: m[2] } : null;
}

interface AsUserInit {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
}

/**
 * One client-server call as `mxid`. Resolves with the raw Response (body
 * unread) on any HTTP status other than a first 401; the caller decides.
 */
async function fetchAsUser(
  mxid: string,
  path: string,
  init: AsUserInit,
  operation: string,
): Promise<{ ok: true; response: Response } | MediaErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await ensureUserToken(mxid);
    if (tok.ok === false) return tok;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${creds.homeserverBase}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${tok.token}`, ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, status: 504, error: ERR_TIMEOUT };
      }
      databaseLogger.error("matrix media proxy error", err, { operation });
      return { ok: false, status: 502, error: ERR_PROXY };
    }
    // Headers are in; a long body read is governed by the caller.
    clearTimeout(timeoutId);
    if (response.status === 401 && attempt === 0) {
      void response.body?.cancel().catch(() => {});
      evictUserToken(mxid);
      continue;
    }
    return { ok: true, response };
  }
  return { ok: false, status: 401, error: ERR_NON_2XX };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The chat server's upload limit in bytes, or null when it doesn't say.
 * Tries the authenticated endpoint first, then the legacy one.
 */
export async function getMediaConfigAsUser(
  mxid: string,
): Promise<{ ok: true; maxUploadBytes: number | null } | MediaErr> {
  let last: MediaErr = { ok: false, status: 502, error: ERR_NON_2XX };
  for (const path of ["/_matrix/client/v1/media/config", "/_matrix/media/v3/config"]) {
    const r = await fetchAsUser(mxid, path, { method: "GET" }, "matrix_media_config");
    if (r.ok === false) return r;
    if (!r.response.ok) {
      void r.response.body?.cancel().catch(() => {});
      last = { ok: false, status: r.response.status, error: ERR_NON_2XX };
      continue;
    }
    const json = await readJson(r.response);
    const size = json?.["m.upload.size"];
    return {
      ok: true,
      maxUploadBytes: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
    };
  }
  return last;
}

/** POST /_matrix/media/v3/upload as the user → the file's mxc URI. */
export async function uploadMediaAsUser(
  mxid: string,
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<{ ok: true; mxc: string } | MediaErr> {
  const r = await fetchAsUser(
    mxid,
    `/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    },
    "matrix_media_upload",
  );
  if (r.ok === false) return r;
  if (!r.response.ok) {
    void r.response.body?.cancel().catch(() => {});
    return { ok: false, status: r.response.status, error: ERR_NON_2XX };
  }
  const json = await readJson(r.response);
  const uri = json?.content_uri;
  if (typeof uri !== "string" || parseMxc(uri) === null) {
    return { ok: false, status: 502, error: ERR_MALFORMED };
  }
  return { ok: true, mxc: uri };
}

/** PUT an m.room.message event into the room as the user. */
export async function sendRoomEventAsUser(
  mxid: string,
  roomId: string,
  content: Record<string, unknown>,
  txnId: string,
): Promise<{ ok: true; eventId: string } | MediaErr> {
  const r = await fetchAsUser(
    mxid,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content),
    },
    "matrix_room_send_file_event",
  );
  if (r.ok === false) return r;
  if (!r.response.ok) {
    void r.response.body?.cancel().catch(() => {});
    return { ok: false, status: r.response.status, error: ERR_NON_2XX };
  }
  const json = await readJson(r.response);
  const eventId = json?.event_id;
  if (typeof eventId !== "string" || eventId.length === 0) {
    return { ok: false, status: 502, error: ERR_MALFORMED };
  }
  return { ok: true, eventId };
}

/** One room event, read as the user (the server refuses non-members). */
export interface RoomMessageEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  room_id?: string;
  content?: Record<string, unknown>;
}

export async function getRoomEventAsUser(
  mxid: string,
  roomId: string,
  eventId: string,
): Promise<{ ok: true; event: RoomMessageEvent } | MediaErr> {
  const r = await fetchAsUser(
    mxid,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    { method: "GET" },
    "matrix_room_get_event",
  );
  if (r.ok === false) return r;
  if (!r.response.ok) {
    void r.response.body?.cancel().catch(() => {});
    return { ok: false, status: r.response.status, error: ERR_NON_2XX };
  }
  const json = await readJson(r.response);
  if (json === null) return { ok: false, status: 502, error: ERR_MALFORMED };
  return { ok: true, event: json as RoomMessageEvent };
}

/**
 * Open a download of `mxc` as the user. Resolves with the live Response
 * (status 200 or 206, body unread) so callers can stream it; `range` is
 * passed through. Uses the authenticated media endpoint, falling back to
 * the legacy one on servers that don't have it.
 */
export async function openMediaDownloadAsUser(
  mxid: string,
  mxc: string,
  range?: string,
): Promise<{ ok: true; response: Response } | MediaErr> {
  const parts = parseMxc(mxc);
  if (!parts) return { ok: false, status: 400, error: "invalid_mxc" };
  const tail = `${encodeURIComponent(parts.server)}/${encodeURIComponent(parts.mediaId)}`;
  const headers: Record<string, string> = range ? { Range: range } : {};
  let last: MediaErr = { ok: false, status: 502, error: ERR_NON_2XX };
  for (const prefix of ["/_matrix/client/v1/media/download/", "/_matrix/media/v3/download/"]) {
    const r = await fetchAsUser(
      mxid,
      `${prefix}${tail}`,
      { method: "GET", headers, timeoutMs: TRANSFER_TIMEOUT_MS },
      "matrix_media_download",
    );
    if (r.ok === false) return r;
    if (r.response.ok) return r;
    void r.response.body?.cancel().catch(() => {});
    last = { ok: false, status: r.response.status, error: ERR_NON_2XX };
    // Only an endpoint the server doesn't know is worth a second try; a
    // missing file is missing on both.
    if (r.response.status !== 404 && r.response.status !== 405 && r.response.status !== 400) {
      return last;
    }
  }
  return last;
}
