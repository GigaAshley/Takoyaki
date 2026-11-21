/**
 * relay-room-faces.ts — the stacked faces each relay-room row in the
 * sidebar shows: the first two members besides the viewer, in the order
 * they joined, plus how many others there are (for the "+N").
 *
 * Called from /sessions/list. Best-effort: a room whose members can't be
 * read in time just has no faces (the row falls back to its plain icon);
 * the sidebar response is never failed or held up for long over faces.
 */

import { db } from "../database/db/index.js";
import { users } from "../database/db/schema.js";
import { databaseLogger } from "../utils/logger.js";
import {
  getRoomStateAdmin,
  type RoomStateEvent,
} from "../matrix/matrix-room-actions-client.js";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Joined members, oldest join first (ties keep the server's order). */
export function joinedMembersInJoinOrder(events: readonly RoomStateEvent[]): string[] {
  return events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        e.type === "m.room.member" &&
        typeof e.state_key === "string" &&
        e.state_key.length > 0 &&
        e.content?.membership === "join",
    )
    .sort(
      (a, b) =>
        num(a.e.origin_server_ts, Number.MAX_SAFE_INTEGER) -
          num(b.e.origin_server_ts, Number.MAX_SAFE_INTEGER) || a.i - b.i,
    )
    .map(({ e }) => e.state_key as string);
}

export interface RoomFace {
  mxid: string;
  kind: "human" | "agent";
  /** The person's username; for agents the mxid localpart. */
  name: string;
  /** Present for people: their user id and uploaded picture (if any). */
  userId?: string;
  avatarPath?: string | null;
}

export interface RoomFaces {
  faces: RoomFace[];
  /** How many members besides the viewer (for the "+N"). */
  othersCount: number;
}

/** The first two members besides the viewer, in join order. */
export function pickRoomFaces(
  membersInJoinOrder: readonly string[],
  viewerMxid: string | null,
  humans: ReadonlyMap<string, { displayName: string; userId: string; avatarPath: string | null }>,
): RoomFaces {
  const others = membersInJoinOrder.filter((m) => m !== viewerMxid);
  const faces = others.slice(0, 2).map((mxid): RoomFace => {
    const human = humans.get(mxid);
    if (human) {
      return {
        mxid,
        kind: "human",
        name: human.displayName,
        userId: human.userId,
        avatarPath: human.avatarPath,
      };
    }
    const colon = mxid.indexOf(":");
    return {
      mxid,
      kind: "agent",
      name: mxid.startsWith("@") && colon > 1 ? mxid.slice(1, colon) : mxid,
    };
  });
  return { faces, othersCount: others.length };
}

// ---------------------------------------------------------------------------
// Member order cache — one admin state read per room per TTL, shared by all
// users' sidebar loads.
// ---------------------------------------------------------------------------

export const ROOM_MEMBERS_CACHE_TTL_MS = 30_000;

interface MembersCacheEntry {
  members: string[];
  expiresAt: number;
}
const membersCache = new Map<string, MembersCacheEntry>();
const membersInFlight = new Map<string, Promise<string[] | null>>();

export function __resetRoomMembersCacheForTests(): void {
  membersCache.clear();
  membersInFlight.clear();
}

export function invalidateRoomMembers(roomId: string): void {
  membersCache.delete(roomId);
}

/**
 * The room's joined members in join order, or null when the room state
 * couldn't be read (the row then shows no faces, never an error). A stale
 * entry is served on a failed refresh.
 */
export async function getRoomMembersInJoinOrder(
  roomId: string,
  deps: { getRoomState: typeof getRoomStateAdmin } = { getRoomState: getRoomStateAdmin },
): Promise<string[] | null> {
  const now = Date.now();
  const cached = membersCache.get(roomId);
  if (cached && cached.expiresAt > now) return cached.members;
  const pending = membersInFlight.get(roomId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const state = await deps.getRoomState(roomId);
      if (state.ok === false) {
        databaseLogger.debug("relay room faces: state read failed", {
          operation: "relay_room_faces_state_failed",
          roomId,
          status: state.status,
          error: state.error,
        });
        return cached?.members ?? null;
      }
      const members = joinedMembersInJoinOrder(state.events);
      membersCache.set(roomId, { members, expiresAt: Date.now() + ROOM_MEMBERS_CACHE_TTL_MS });
      return members;
    } finally {
      membersInFlight.delete(roomId);
    }
  })();
  membersInFlight.set(roomId, p);
  return p;
}

/** Longest the sidebar load waits on faces before sending rows without. */
export const ROOM_FACES_BUDGET_MS = 3_000;

interface HumanRow {
  displayName: string;
  userId: string;
  avatarPath: string | null;
}

async function loadHumans(): Promise<{ byMxid: Map<string, HumanRow>; mxidByUserId: Map<string, string> }> {
  const rows = (await db
    .select({
      id: users.id,
      username: users.username,
      mxid: users.mxid,
      avatarPath: users.avatarPath,
    })
    .from(users)) as Array<{
    id: string;
    username: string | null;
    mxid: string | null;
    avatarPath: string | null;
  }>;
  const byMxid = new Map<string, HumanRow>();
  const mxidByUserId = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.mxid !== "string" || r.mxid.length === 0) continue;
    byMxid.set(r.mxid, {
      displayName: r.username && r.username.length > 0 ? r.username : r.mxid,
      userId: r.id,
      avatarPath: r.avatarPath ?? null,
    });
    mxidByUserId.set(r.id, r.mxid);
  }
  return { byMxid, mxidByUserId };
}

/** roomId → faces for this viewer. Rooms missing from the map show none. */
export async function loadRoomFacesForViewer(
  userId: string,
  roomIds: readonly string[],
  deps: {
    getMembers: (roomId: string) => Promise<string[] | null>;
    loadHumans: typeof loadHumans;
    budgetMs: number;
  } = { getMembers: getRoomMembersInJoinOrder, loadHumans, budgetMs: ROOM_FACES_BUDGET_MS },
): Promise<Map<string, RoomFaces>> {
  const out = new Map<string, RoomFaces>();
  if (roomIds.length === 0) return out;
  try {
    const humans = await deps.loadHumans();
    const viewerMxid = humans.mxidByUserId.get(userId) ?? null;
    const work = Promise.all(
      roomIds.map(async (roomId) => {
        const members = await deps.getMembers(roomId);
        if (members !== null) out.set(roomId, pickRoomFaces(members, viewerMxid, humans.byMxid));
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), deps.budgetMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      databaseLogger.debug("relay room faces: budget ran out, sending partial faces", {
        operation: "relay_room_faces_budget_exceeded",
        userId,
        rooms: roomIds.length,
        resolved: out.size,
      });
      return new Map(out);
    }
  } catch (err) {
    databaseLogger.warn("relay room faces failed — rows sent without faces", {
      operation: "relay_room_faces_failed",
      userId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  return out;
}
