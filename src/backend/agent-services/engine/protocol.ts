/**
 * agent-services/engine/protocol.ts — the wire format between a machine's
 * `fleet-service` command and the backend (http/routes.ts).
 *
 * A request is `POST /agent-services/v1/jobs/<id>` from the machine, with its
 * credential, as multipart form data:
 *
 *   request              JSON: {service, input, as_user?}
 *   attachment.<slot>    one file per attachment slot; its filename's
 *                        extension is the attachment's type
 *
 * <id> is a UUID the caller picks. The answer is the response JSON below,
 * whose `files` describe output files fetched separately by index.
 *
 *   {ok:true,  service, result, files:[{ext, size}]}
 *   {ok:false, service, error:{code, message?, ...}}
 *
 * Pure module: no I/O, no logger.
 */

import type {
  AttachmentSpec,
  EngineErrorCode,
  ServiceOutputFile,
  ServiceResult,
} from "./types.js";

/** Canonical lower/upper-case dashed UUID. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const EXT_RE = /^[a-z0-9]{1,8}$/;

/** Form field name prefix for attachments: `attachment.<slot>`. */
export const ATTACHMENT_FIELD_PREFIX = "attachment.";

/** One request as the engine takes it. */
export interface IncomingRequest {
  /** Caller-chosen UUID. */
  id: string;
  service: string;
  input: unknown;
  /** App username the request acts for (services with userSecrets). */
  asUser?: string;
  /** slot → the file sent in it. */
  attachments: Record<string, { ext: string; bytes: Buffer }>;
}

// ---------------------------------------------------------------------------
// Request envelope
// ---------------------------------------------------------------------------

interface RequestEnvelope {
  service: string;
  input: unknown;
  as_user?: string;
}

const ENVELOPE_KEYS = new Set(["service", "input", "as_user"]);

export type EnvelopeParse =
  | { ok: true; envelope: RequestEnvelope }
  | { ok: false; message: string; service?: string };

export function parseEnvelope(body: string): EnvelopeParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "request must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const service = typeof obj.service === "string" ? obj.service : undefined;
  const fail = (message: string): EnvelopeParse => ({
    ok: false,
    message,
    service,
  });

  for (const k of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(k)) return fail(`unrecognized request field: ${k}`);
  }
  if (service === undefined || !SERVICE_NAME_RE.test(service)) {
    return fail("service must be a kebab-case service name");
  }
  if (!("input" in obj)) return fail("input is required");

  if (
    obj.as_user !== undefined &&
    (typeof obj.as_user !== "string" ||
      obj.as_user.length === 0 ||
      obj.as_user.length > 200)
  ) {
    return fail("as_user must be a username");
  }

  return {
    ok: true,
    envelope: {
      service,
      input: obj.input,
      ...(obj.as_user !== undefined ? { as_user: obj.as_user as string } : {}),
    },
  };
}

/** The attachment extension from a sent filename, lower-cased, or null. */
export function attachmentExt(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_RE.test(ext) ? ext : null;
}

/** Why a sent attachment doesn't fit its slot, or null when it does. */
export function attachmentError(
  slot: string,
  file: { ext: string; bytes: Buffer },
  spec: AttachmentSpec,
): string | null {
  if (!EXT_RE.test(file.ext)) return `attachment ${slot} has a bad extension`;
  if (!spec.extensions.includes(file.ext)) {
    return `attachment ${slot} must be one of: ${spec.extensions.join(", ")}`;
  }
  if (file.bytes.byteLength === 0) return `attachment ${slot} is missing or empty`;
  if (file.bytes.byteLength > spec.maxBytes) {
    return `attachment ${slot} exceeds ${spec.maxBytes} bytes`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type WireResponse =
  | {
      ok: true;
      service: string;
      result: unknown;
      files: Array<{ ext: string; size: number }>;
    }
  | {
      ok: false;
      service: string | null;
      error: { code: string; message?: string; [k: string]: unknown };
    };

/** Build the response JSON from a service result and its output files. */
export function buildResponse(
  service: string | null,
  result: ServiceResult | EngineFailure,
  files: readonly ServiceOutputFile[] = [],
): WireResponse {
  if (result.ok === true) {
    return {
      ok: true,
      service: service ?? "",
      result: result.result,
      files: files.map((f) => ({ ext: f.ext, size: f.bytes.byteLength })),
    };
  }
  const error: { code: string; message?: string; [k: string]: unknown } = {
    ...(result.details ?? {}),
    code: result.code,
  };
  if (result.message !== undefined) error.message = result.message;
  return { ok: false, service, error };
}

export interface EngineFailure {
  ok: false;
  code: EngineErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

export function engineFailure(
  code: EngineErrorCode,
  message?: string,
): EngineFailure {
  return message === undefined
    ? { ok: false, code }
    : { ok: false, code, message };
}
