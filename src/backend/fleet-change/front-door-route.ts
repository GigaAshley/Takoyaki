/**
 * front-door-route.ts — the part every route that sends one change to a
 * machine's front door shares: open the machine (withHost), send the request
 * (waiting, or following it up to `totalS`), log it, and answer with the
 * machine's outcome.
 */

import type { Response } from "express";
import type { Client as SSHClientType } from "ssh2";
import { databaseLogger } from "../utils/logger.js";
import { HttpError, withHost } from "../sharing/host-conn.js";
import {
  frontDoorHttp,
  submitAndFollow,
  submitFrontDoor,
  type FrontDoorKind,
  type FrontDoorOutcome,
} from "./front-door.js";

/** A positive integer host id from a body field or path parameter, else null. */
export function parseHostId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function answerFromFrontDoor(
  res: Response,
  opts: {
    hostId: number;
    userId: string;
    kind: FrontDoorKind;
    args: Record<string, unknown>;
    requestId: string;
    /** Log operation name, e.g. "identity_archive_request". */
    operation: string;
    /** Keep asking until finished or this many seconds have passed; otherwise one wait. */
    totalS?: number;
    /** A route's own answer for an outcome; null falls back to the usual one. */
    answer?: (outcome: FrontDoorOutcome) => { status: number; body: Record<string, unknown> } | null;
    /** The server's part once the change is done (tell open tabs), on the same connection.
     *  Its failure is logged; the change itself already happened. */
    onDone?: (conn: SSHClientType | null, outcome: Extract<FrontDoorOutcome, { state: "done" }>) => Promise<void>;
    /** Clean-up when the machine never took the change (still updating, or unreachable). */
    onNotTaken?: (conn: SSHClientType | null) => Promise<void>;
  },
): Promise<Response> {
  const { hostId, userId, kind, args, requestId, operation } = opts;
  try {
    const outcome = await withHost(hostId, userId, async (conn) => {
      const o =
        opts.totalS !== undefined
          ? await submitAndFollow(conn, kind, args, { id: requestId, hostId, totalS: opts.totalS })
          : await submitFrontDoor(conn, kind, args, { id: requestId, hostId });
      if (o.state === "done" && opts.onDone) {
        try {
          await opts.onDone(conn, o);
        } catch (err) {
          databaseLogger.warn(`${kind}: the server's part after it was done failed`, {
            operation: `${operation}_after_failed`,
            hostId,
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (o.state === "not_installed" && opts.onNotTaken) await opts.onNotTaken(conn).catch(() => undefined);
      return o;
    });
    databaseLogger.info(`${kind} requested`, {
      operation,
      userId,
      hostId,
      target: args.name ?? args.slug,
      requestId,
      outcome: outcome.state,
      code: "code" in outcome ? outcome.code : undefined,
    });
    const { status, body } = opts.answer?.(outcome) ?? frontDoorHttp(outcome);
    return res.status(status).json(body);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    databaseLogger.error(`${kind} request failed`, {
      operation: `${operation}_failed`,
      hostId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "couldn't ask the machine" });
  }
}

const UNARCHIVE_REASONS = new Set(["archive_not_found", "name_collision", "missing_roles", "identity_unreadable"]);

/**
 * The un-archive routes' answer, in the shape their callers read:
 *   done → 200 { ok, outcome: "restored" }; still working → 200 { ok, outcome: "pending" };
 *   refused → 409 { reason, message, code, missingRoles? } (reason is the code when the client
 *   knows it, else "refused" with the machine's reason as message).
 */
export function unarchiveAnswer(outcome: FrontDoorOutcome): { status: number; body: Record<string, unknown> } | null {
  switch (outcome.state) {
    case "done":
      return { status: 200, body: { ok: true, outcome: "restored", requestId: outcome.id } };
    case "pending":
      return { status: 200, body: { ok: true, outcome: "pending", requestId: outcome.id } };
    case "refused": {
      const missing = (outcome.result as { missingRoles?: unknown } | undefined)?.missingRoles;
      return {
        status: 409,
        body: {
          reason: UNARCHIVE_REASONS.has(outcome.code) ? outcome.code : "refused",
          code: outcome.code,
          message: outcome.reason,
          requestId: outcome.id,
          ...(Array.isArray(missing) ? { missingRoles: missing } : {}),
        },
      };
    }
    default:
      return null;
  }
}
