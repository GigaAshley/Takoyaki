/**
 * relay-room-file-serve.ts — the file routes' answer for a room file's
 * address (`/file/.relay-room/<roomId>/<eventId>/<name>`).
 *
 * Called from both file routes when the host segment is the reserved room
 * file host:
 *   - GET /file/:host/*            → stream the file (Range passed through)
 *   - POST /pretty-view/fetch-host-file → the viewer's base64 envelope
 *
 * Same response contract as a machine's file: per-extension content type
 * with html / js / svg forced to download, nosniff + no-store on every
 * response, classified error strings only (never a Matrix error or path).
 */

import type { Request, Response } from "express";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { classifyByExtension } from "../../utils/editable-file-whitelist.js";
import { sniffTextBytes } from "../../utils/editable-file-byte-sniff.js";
import {
  attachmentDisposition,
  COMMON_RESPONSE_HEADERS,
  dispatchByExtensionOnly,
  extractExtension,
  parseRangeHeader,
  type DispatchResult,
} from "../../utils/sftp-file-response.js";
import { databaseLogger } from "../../utils/logger.js";
import {
  openRoomFile,
  parseRoomFilePath,
  readRoomFile,
} from "../../relay-sessions/relay-room-files.js";

/** Types a file post may declare that are safe to show in place. */
const SAFE_INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i;

/** Content type + disposition for a room file: its name first, then its declared type. */
export function dispatchRoomFile(name: string, mimetype: string | null): DispatchResult {
  const byExt = dispatchByExtensionOnly(extractExtension(name));
  if (byExt) return byExt;
  if (mimetype && SAFE_INLINE_MIME.test(mimetype)) {
    return {
      contentType: mimetype.toLowerCase() === "text/plain" ? "text/plain; charset=utf-8" : mimetype.toLowerCase(),
      disposition: "inline",
    };
  }
  return { contentType: "application/octet-stream", disposition: "attachment" };
}

/** Pass through only bytes start..end (inclusive) of a stream. */
export function byteSlice(start: number, end: number): Transform {
  let pos = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const from = Math.max(start - pos, 0);
      const to = Math.min(end - pos + 1, chunk.byteLength);
      pos += chunk.byteLength;
      if (from < to) this.push(chunk.subarray(from, to));
      if (pos > end) this.push(null);
      cb();
    },
  });
}

function sendErrorText(res: Response, status: number, errorClass: string): void {
  res.set({ ...COMMON_RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.status(status).send(errorClass);
}

export async function serveRoomFileGet(
  req: Request,
  res: Response,
  userId: string,
  absolutePath: string,
): Promise<void> {
  const addr = parseRoomFilePath(absolutePath);
  if (!addr) {
    sendErrorText(res, 404, "not_found");
    return;
  }
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const opened = await openRoomFile(userId, addr, range);
  if (opened.ok === false) {
    sendErrorText(res, opened.status, opened.errorClass);
    return;
  }
  const upstream = opened.response;
  const dispatch = dispatchRoomFile(opened.post.name, opened.post.mimetype);
  const headers: Record<string, string> = {
    ...COMMON_RESPONSE_HEADERS,
    "content-type": dispatch.contentType,
    "accept-ranges": "bytes",
  };
  const len = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  // Chat servers may answer a ranged request with the whole file. Media
  // players (Safari especially) need a real partial answer to play and
  // scrub, so cut the asked-for bytes out here.
  let slice: { start: number; end: number } | null = null;
  const total = Number(len);
  if (range && upstream.status === 200 && len && Number.isFinite(total)) {
    const spec = parseRangeHeader(range, total);
    if (spec === "unsatisfiable") {
      void upstream.body?.cancel().catch(() => {});
      res.set({ ...COMMON_RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8", "content-range": `bytes */${total}` });
      res.status(416).send("range_not_satisfiable");
      return;
    }
    if (spec) slice = spec;
  }
  if (slice) {
    headers["content-length"] = String(slice.end - slice.start + 1);
    headers["content-range"] = `bytes ${slice.start}-${slice.end}/${total}`;
  } else {
    if (len) headers["content-length"] = len;
    if (upstream.status === 206 && contentRange) headers["content-range"] = contentRange;
  }
  if (dispatch.disposition === "attachment") {
    headers["content-disposition"] = attachmentDisposition(opened.post.name);
  }
  res.set(headers);
  res.status(upstream.status === 206 || slice ? 206 : 200);
  if (!upstream.body) {
    res.end();
    return;
  }
  const whole = Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream);
  const body = slice ? whole.pipe(byteSlice(slice.start, slice.end)) : whole;
  if (slice) {
    body.on("end", () => whole.destroy());
    whole.on("error", (err) => body.destroy(err));
  }
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    res.on("close", () => {
      body.destroy();
      finish();
    });
    body.on("error", (err) => {
      databaseLogger.warn("relay room file stream error", {
        operation: "relay_room_file_stream_error",
        userId,
        roomId: addr.roomId,
        eventId: addr.eventId,
        error: err instanceof Error ? err.message : "unknown",
      });
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      finish();
    });
    body.pipe(res);
  });
}

export async function serveRoomFilePost(
  res: Response,
  userId: string,
  absolutePath: string,
  maxBytes: number,
): Promise<void> {
  const addr = parseRoomFilePath(absolutePath);
  if (!addr) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const read = await readRoomFile(userId, addr, maxBytes);
  if (read.ok === false) {
    res.status(read.status).json({ error: read.errorClass });
    return;
  }
  const filename = read.post.name;
  const extension = extractExtension(filename);
  const isTextByExt = classifyByExtension(extension, filename);
  const isTextByBytes = isTextByExt ? undefined : sniffTextBytes(new Uint8Array(read.bytes));
  res.status(200).json({
    contentBase64: read.bytes.toString("base64"),
    sizeBytes: read.bytes.byteLength,
    contentType: null,
    extension,
    filename,
    isTextByExt,
    isTextByBytes,
  });
}
