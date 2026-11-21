// matrix-room-tag-client — Matrix account_data `m.tag` read/write layer for
// relay-room project membership (Phase 117 Plan 117-02, D-05 / D-05a / D-06).
//
// The relay-room half of the project-membership carrier. Identity-associated
// conversations store `project: <slug>` in the identity file's frontmatter
// (Plan 117-01); relay-room conversations store `u.project.<slug>` in the
// per-user Matrix `m.tag` account_data event on the room. This module owns
// the GET + read-modify-write PUT cycle for that account_data event.
//
// Shape mirrors matrix-admin-client.ts (:1-125) verbatim:
//   1. resolves creds via getMatrixAdminCreds(); returns 500/creds-missing on null.
//   2. every user-supplied path segment (userMxid, roomId) passes through
//      encodeURIComponent — path-traversal defense per T-117-02-02.
//   3. sends Authorization: Bearer <per-user-token> + Content-Type: application/json.
//   4. AbortController wraps every fetch with REQUEST_TIMEOUT_MS = 30_000.
//   5. returns {ok:true, ...} | {ok:false, status, error} — never leaks upstream
//      body, never logs the admin token or its prefix.
//   6. clearTimeout in both success and error paths.
//
// CRITICAL (T-117-02-01): Matrix's `m.tag` is a PER-USER account_data event
// per Client-Server spec § 13.4. Writing tags with the admin token attaches
// them to @skynet-admin instead of the acting user. This module ALWAYS uses
// the per-user token minted by matrix-admin-client's ensureUserToken cache
// (which does the loginAsUser round-trip + 1-hour TTL); the admin token is
// never passed as the Bearer for either GET or PUT.

import { databaseLogger } from "../utils/logger.js";
import { getMatrixAdminCreds } from "./matrix-admin-creds-store.js";
import { ensureUserToken } from "./matrix-admin-client.js";
import { assertAdminErr } from "./matrix-admin-narrow.js";
import { PROJECT_SLUG_RE } from "../claude-session/identity-artifact-reader.js";

/** 30s AbortController timeout for every account_data fetch. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Stable error code emitted when getMatrixAdminCreds() returns null. */
const ERR_CREDS_MISSING = "matrix_admin_creds_missing";
/** Stable error code emitted when Matrix replies non-2xx (and not 404 on GET). */
const ERR_NON_2XX = "matrix_room_tag_non_2xx";
/** Stable error code emitted on AbortError (30s timeout expired). */
const ERR_TIMEOUT = "matrix_room_tag_timeout";
/** Stable error code emitted on any other thrown error (network / parse). */
const ERR_PROXY = "matrix_room_tag_proxy_error";
/** Stable error code emitted when the GET response has a non-object `tags` field. */
const ERR_MALFORMED = "matrix_room_tag_malformed_response";

/**
 * Discriminated-union error shape — byte-shape parallel to
 * matrix-admin-client's `AdminErr` (:50). Duplicated locally so this module
 * doesn't couple to matrix-admin-client's internal type layout; every error
 * code emitted here starts with `matrix_room_tag_` (or `matrix_admin_creds_`
 * on the shared creds-missing case) so callers get a uniform surface.
 */
export type AdminErr = { ok: false; status: number; error: string };

/** Success shape for getRoomTags. `tags` is opaque `Record<string, unknown>`
 * so callers can round-trip unknown-to-them keys (favorites, low-priority,
 * user-added `u.*` tags) through setRoomProjectTag without loss. */
export type GetRoomTagsOk = { ok: true; tags: Record<string, unknown> };

/**
 * GET /_matrix/client/v3/user/{userId}/rooms/{roomId}/account_data/m.tag
 *
 * Returns the room's current `m.tag` account_data blob AS the specified user.
 * 404 is a valid state — Matrix returns 404 when no m.tag event has been
 * PUT for this (user, room) pair, and we map that to `{ok:true, tags: {}}`
 * because "no tags yet" is legitimate data, not an error.
 *
 * CRITICAL: uses the per-user token minted by `ensureUserToken(userMxid)`,
 * NOT the admin token. Matrix's account_data is a per-user event; a read
 * with the admin token would return @skynet-admin's account_data for the
 * room, not the acting user's (T-117-02-01).
 *
 * Path-traversal defense: encodeURIComponent on BOTH userMxid AND roomId
 * (T-117-02-02 — mirrors matrix-admin-client.ts:1315-1316).
 */
export async function getRoomTags(
  userMxid: string,
  roomId: string,
): Promise<GetRoomTagsOk | AdminErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) {
    return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  }

  // Mint (or reuse cached) per-user token. Failures propagate verbatim so
  // the caller can distinguish creds-missing (500) from Synapse auth
  // failures (whatever loginAsUser saw) without wrapping.
  const tokenResult = await ensureUserToken(userMxid);
  if (!tokenResult.ok) {
    assertAdminErr(tokenResult);
    return tokenResult;
  }

  const url =
    creds.homeserverBase +
    "/_matrix/client/v3/user/" +
    encodeURIComponent(userMxid) +
    "/rooms/" +
    encodeURIComponent(roomId) +
    "/account_data/m.tag";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // 404 = no m.tag account_data event yet for this (user, room). Per
    // Matrix Client-Server spec § 13.3, absent account_data is a valid
    // state — map to empty tags so callers can treat "no tags" and
    // "unset event" uniformly.
    if (response.status === 404) {
      return { ok: true, tags: {} };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: ERR_NON_2XX };
    }

    const parsed = (await response.json()) as { tags?: unknown };
    // Tolerate missing `tags` field (fallback to {}) but reject non-object
    // shapes explicitly — a homeserver bug or middleware could return an
    // array or primitive, and we don't want to attempt a merged write from
    // garbage (T-117-02-04).
    if (parsed.tags === undefined || parsed.tags === null) {
      return { ok: true, tags: {} };
    }
    if (Array.isArray(parsed.tags) || typeof parsed.tags !== "object") {
      databaseLogger.warn(
        "matrix room tag GET returned non-object `tags` field",
        {
          operation: "matrix_room_tag_get",
          tagsType: Array.isArray(parsed.tags) ? "array" : typeof parsed.tags,
        },
      );
      return { ok: false, status: 502, error: ERR_MALFORMED };
    }
    return { ok: true, tags: parsed.tags as Record<string, unknown> };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 504, error: ERR_TIMEOUT };
    }
    databaseLogger.error("matrix room tag proxy error", err, {
      operation: "matrix_room_tag_get",
    });
    return { ok: false, status: 502, error: ERR_PROXY };
  }
}

/**
 * A room's pin in the sidebar: the favourite key in the room's `m.tag`
 * account data — the same per-user blob that carries the project tag. Synapse
 * keeps that blob apart from its own tag store (the /tags endpoints), so other
 * chat apps don't see it as a favourite.
 */
export const FAVOURITE_TAG = "m.favourite";

/** What a room-tag write left on the room: its project (if any) and its pin. */
export type RoomPlacement = { project: string | null; pinned: boolean };
export type RoomTagWriteOk = { ok: true } & RoomPlacement;

/** Read the placement out of a room's tags (project outranks pin). */
export function placementOf(tags: Record<string, unknown>): RoomPlacement {
  const projectKey = Object.keys(tags).find((k) => PROJECT_TAG_RE.test(k) && k.length > PROJECT_TAG_PREFIX.length);
  return {
    project: projectKey ? projectKey.slice(PROJECT_TAG_PREFIX.length) : null,
    pinned: Object.prototype.hasOwnProperty.call(tags, FAVOURITE_TAG),
  };
}

const PROJECT_TAG_PREFIX = "u.project.";
const PROJECT_TAG_RE = /^u\.project\./;

/**
 * D-05a read-modify-write cycle for the `u.project.<slug>` tag on a room.
 *
 * PUT /_matrix/client/v3/user/{userId}/rooms/{roomId}/account_data/m.tag
 *
 * The 5-step protocol per CONTEXT.md § D-05a:
 *   1. GET the room's existing `m.tag` blob via getRoomTags.
 *   2. Preserve every non-project key (low-priority, other u.* tags).
 *   3. Strip EVERY key matching /^u\.project\./ (D-06 single-project invariant —
 *      defensively removes any pre-existing multi-tag state, not just the one
 *      the caller may know about).
 *   4. Drop the favourite tag (any project write unpins — pinned and
 *      in-a-project are exclusive), then if projectSlug is not null set
 *      `newTags["u.project." + projectSlug] = {}`.
 *   5. PUT the merged blob.
 *
 * Invalid slug throws BEFORE any HTTP call (T-117-02-03) — a bad slug is a
 * caller programming error, not a runtime failure. The route layer (Plan
 * 117-05) converts this to a 400 for the client.
 *
 * CRITICAL (T-117-02-01): uses per-user token, NOT admin token. Same
 * rationale as getRoomTags — m.tag is a per-user event.
 */
export async function setRoomProjectTag(
  userMxid: string,
  roomId: string,
  projectSlug: string | null,
): Promise<RoomTagWriteOk | AdminErr> {
  // T-117-02-03: validate slug BEFORE any HTTP call. Throws (not AdminErr)
  // because a malformed slug is a programming error at the call site — the
  // route layer catches and returns 400.
  if (projectSlug !== null && !PROJECT_SLUG_RE.test(projectSlug)) {
    throw new Error(`invalid project slug: ${projectSlug}`);
  }
  return writeRoomTags(userMxid, roomId, "matrix_room_tag_put", (current) => {
    const next: Record<string, unknown> = Object.fromEntries(
      Object.entries(current).filter(([k]) => !PROJECT_TAG_RE.test(k)),
    );
    // Any project write leaves the room unpinned: filing it takes it out of
    // Pinned, and "Remove from project" on a room that somehow carries both
    // lands it in Conversations — the same as an agent conversation.
    delete next[FAVOURITE_TAG];
    if (projectSlug !== null) {
      next["u.project." + projectSlug] = {};
    }
    return next;
  });
}

/**
 * Resolves with the placement the write left (project + pin).
 *
 * Pin (favourite) or unpin a room for one user — same read-modify-write as
 * setRoomProjectTag. Pinning strips every project tag in the same write, so
 * the room is never left both pinned and in a project; unpinning removes only
 * the favourite tag. An existing favourite's content (e.g. another app's
 * `order`) is kept.
 */
export async function setRoomPinned(
  userMxid: string,
  roomId: string,
  pinned: boolean,
): Promise<RoomTagWriteOk | AdminErr> {
  return writeRoomTags(userMxid, roomId, "matrix_room_tag_pin", (current) => {
    const next: Record<string, unknown> = { ...current };
    if (pinned) {
      for (const k of Object.keys(next)) {
        if (PROJECT_TAG_RE.test(k)) delete next[k];
      }
      const prior = next[FAVOURITE_TAG];
      next[FAVOURITE_TAG] =
        prior !== null && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
    } else {
      delete next[FAVOURITE_TAG];
    }
    return next;
  });
}

/**
 * GET the room's tags as the user, apply `mutate`, PUT the result back.
 * Every tag `mutate` doesn't touch round-trips unchanged.
 */
async function writeRoomTags(
  userMxid: string,
  roomId: string,
  operation: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<RoomTagWriteOk | AdminErr> {
  const creds = await getMatrixAdminCreds();
  if (!creds) {
    return { ok: false, status: 500, error: ERR_CREDS_MISSING };
  }

  // GET current m.tag blob. Failures propagate verbatim — the caller sees a
  // uniform AdminErr surface whether the GET failed due to creds,
  // ensureUserToken, timeout, or Synapse non-2xx.
  const current = await getRoomTags(userMxid, roomId);
  if (current.ok === false) {
    return current;
  }

  // Mint (or reuse cached) per-user token for the PUT. ensureUserToken is
  // idempotent + cached; the entry minted for the GET is reused.
  const tokenResult = await ensureUserToken(userMxid);
  if (!tokenResult.ok) {
    assertAdminErr(tokenResult);
    return tokenResult;
  }

  const newTags = mutate(current.tags);

  const url =
    creds.homeserverBase +
    "/_matrix/client/v3/user/" +
    encodeURIComponent(userMxid) +
    "/rooms/" +
    encodeURIComponent(roomId) +
    "/account_data/m.tag";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: newTags }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { ok: false, status: response.status, error: ERR_NON_2XX };
    }
    return { ok: true, ...placementOf(newTags) };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 504, error: ERR_TIMEOUT };
    }
    databaseLogger.error("matrix room tag proxy error", err, {
      operation,
    });
    return { ok: false, status: 502, error: ERR_PROXY };
  }
}
