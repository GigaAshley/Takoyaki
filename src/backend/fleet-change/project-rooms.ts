/**
 * project-rooms.ts — the relay rooms a user has filed in some projects, found
 * from the chat server's own list (not the browser's sidebar), and releasing
 * them back to Conversations when those projects are archived.
 *
 * A room's project is a per-user tag (`u.project.<slug>`) on the user's own
 * account, so this looks at every room the user has joined.
 */

import { getUserJoinedRooms } from "../matrix/matrix-admin-client.js";
import { getRoomTags, placementOf, setRoomProjectTag } from "../matrix/matrix-room-tag-client.js";
import { lookupCallerMxid, publishRoomPlacement } from "../database/routes/relay-room-project-tag.js";
import { assertAdminErr } from "../matrix/matrix-admin-narrow.js";
import { databaseLogger } from "../utils/logger.js";

export interface ProjectRoom {
  roomId: string;
  project: string;
}

/** Rooms (and their tags' reads) looked at in parallel. */
const PARALLEL = 8;

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) {
    out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  }
  return out;
}

/**
 * The user's rooms filed in any of `slugs`. Null when the chat server can't
 * be asked (no chat account, server down) — callers say so instead of
 * guessing.
 */
export async function findProjectRooms(userId: string, slugs: readonly string[]): Promise<ProjectRoom[] | null> {
  if (slugs.length === 0) return [];
  const mxid = await lookupCallerMxid(userId);
  if (mxid === null) return [];
  const joined = await getUserJoinedRooms(mxid);
  if (!joined.ok) {
    assertAdminErr(joined);
    databaseLogger.warn("project rooms: couldn't list the user's rooms", {
      operation: "project_rooms_list_failed",
      userId,
      status: joined.status,
      error: joined.error,
    });
    return null;
  }
  const wanted = new Set(slugs);
  const placed = await inBatches(joined.roomIds, async (roomId) => {
    const tags = await getRoomTags(mxid, roomId);
    if (!tags.ok) return null;
    const { project } = placementOf(tags.tags);
    return project !== null && wanted.has(project) ? { roomId, project } : null;
  });
  return placed.filter((r): r is ProjectRoom => r !== null);
}

/**
 * Take the user's rooms out of the archived `slugs`, telling their open tabs.
 * Returns the rooms released; a room whose tag couldn't be cleared is logged
 * and left (it shows at top level until moved).
 */
export async function releaseProjectRooms(userId: string, slugs: readonly string[]): Promise<ProjectRoom[]> {
  const rooms = await findProjectRooms(userId, slugs);
  if (rooms === null || rooms.length === 0) return [];
  const mxid = await lookupCallerMxid(userId);
  if (mxid === null) return [];
  const released = await inBatches(rooms, async (room) => {
    const r = await setRoomProjectTag(mxid, room.roomId, null);
    if (!r.ok) {
      assertAdminErr(r);
      databaseLogger.warn("project rooms: couldn't release a room from an archived project", {
        operation: "project_rooms_release_failed",
        userId,
        roomId: room.roomId,
        project: room.project,
        status: r.status,
        error: r.error,
      });
      return null;
    }
    publishRoomPlacement(userId, room.roomId, r.project, r.pinned);
    return room;
  });
  return released.filter((r): r is ProjectRoom => r !== null);
}
