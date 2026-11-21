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
  fetchEventAdmin,
  getRoomStateAdmin,
  type RoomStateEvent,
} from "../matrix/matrix-room-actions-client.js";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Joined members, oldest join first (ties keep the server's order).
 * `joinTs` overrides a member's time with when they really joined — a
 * profile change (new name or picture) is a fresh membership event, so the
 * current event's own time can be much later than the join.
 */
export function joinedMembersInJoinOrder(
  events: readonly RoomStateEvent[],
  joinTs?: ReadonlyMap<string, number>,
): string[] {
  return events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        e.type === "m.room.member" &&
        typeof e.state_key === "string" &&
        e.state_key.length > 0 &&
        e.content?.membership === "join",
    )
    .map(({ e, i }) => ({
      mxid: e.state_key as string,
      ts: joinTs?.get(e.state_key as string) ?? num(e.origin_server_ts, Number.MAX_SAFE_INTEGER),
      i,
    }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map(({ mxid }) => mxid);
}

/** How far back one member's chain of profile changes is followed. */
const MAX_PROFILE_CHANGES_FOLLOWED = 10;
/** Resolved join times by member-event id. Events never change, so this only grows; cleared past the cap. */
const JOIN_TS_MEMO_CAP = 5_000;
const joinTsByEventId = new Map<string, number>();

function replacedEventId(e: RoomStateEvent): string | undefined {
  const r = e.replaces_state ?? e.unsigned?.replaces_state;
  return typeof r === "string" && r.length > 0 ? r : undefined;
}

/** How many lookups one room runs at once, and how many rooms refresh at once. */
const LOOKUP_CONCURRENCY = 4;
const ROOM_REFRESH_CONCURRENCY = 4;

/** Run `fn` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * When each joined member really joined: walk back from their current
 * membership event through the events it replaced while those were still
 * "join" (profile changes), and take the earliest join's time. A finished
 * walk's answer is remembered, so a room is walked once, not on every
 * refresh. A walk cut short (a lookup failed, or the step cap was reached)
 * uses what it found this time but isn't remembered, so the next refresh
 * tries again.
 */
export async function resolveJoinTimes(
  events: readonly RoomStateEvent[],
  fetchEvent: typeof fetchEventAdmin,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const joins = events.filter(
    (e) =>
      e.type === "m.room.member" &&
      typeof e.state_key === "string" &&
      e.content?.membership === "join",
  );
  await forEachLimited(joins, LOOKUP_CONCURRENCY, async (current) => {
    const mxid = current.state_key as string;
    const startId = current.event_id;
    if (startId && joinTsByEventId.has(startId)) {
      out.set(mxid, joinTsByEventId.get(startId) as number);
      return;
    }
    let ts = num(current.origin_server_ts, Number.MAX_SAFE_INTEGER);
    let prevId = replacedEventId(current);
    let finished = false;
    for (let n = 0; n < MAX_PROFILE_CHANGES_FOLLOWED; n++) {
      if (!prevId) {
        finished = true;
        break;
      }
      const memo = joinTsByEventId.get(prevId);
      if (memo !== undefined) {
        ts = Math.min(ts, memo);
        finished = true;
        break;
      }
      const r = await fetchEvent(prevId);
      if (r.ok === false) break;
      const prev = r.event;
      if (prev.type !== "m.room.member" || prev.content?.membership !== "join") {
        finished = true;
        break;
      }
      ts = Math.min(ts, num(prev.origin_server_ts, ts));
      prevId = replacedEventId(prev);
    }
    if (startId && finished) {
      if (joinTsByEventId.size >= JOIN_TS_MEMO_CAP) joinTsByEventId.clear();
      joinTsByEventId.set(startId, ts);
    }
    out.set(mxid, ts);
  });
  return out;
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
  joinTsByEventId.clear();
}

/** Mark a room's members out of date (after Leave): the next read refreshes it. */
export function invalidateRoomMembers(roomId: string): void {
  const cached = membersCache.get(roomId);
  if (cached) cached.expiresAt = 0;
}

// Rooms refreshing right now, capped at ROOM_REFRESH_CONCURRENCY; the rest wait.
let refreshesRunning = 0;
const refreshQueue: Array<() => void> = [];
async function withRefreshSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (refreshesRunning >= ROOM_REFRESH_CONCURRENCY) {
    await new Promise<void>((resolve) => refreshQueue.push(resolve));
  }
  refreshesRunning++;
  try {
    return await fn();
  } finally {
    refreshesRunning--;
    refreshQueue.shift()?.();
  }
}

type MembersDeps = { getRoomState: typeof getRoomStateAdmin; fetchEvent: typeof fetchEventAdmin };

function refreshRoomMembers(roomId: string, deps: MembersDeps): Promise<string[] | null> {
  const pending = membersInFlight.get(roomId);
  if (pending) return pending;
  const p = withRefreshSlot(async () => {
    const state = await deps.getRoomState(roomId);
    if (state.ok === false) {
      databaseLogger.debug("relay room faces: state read failed", {
        operation: "relay_room_faces_state_failed",
        roomId,
        status: state.status,
        error: state.error,
      });
      return membersCache.get(roomId)?.members ?? null;
    }
    const joinTs = await resolveJoinTimes(state.events, deps.fetchEvent);
    const members = joinedMembersInJoinOrder(state.events, joinTs);
    membersCache.set(roomId, { members, expiresAt: Date.now() + ROOM_MEMBERS_CACHE_TTL_MS });
    return members;
  }).finally(() => membersInFlight.delete(roomId));
  membersInFlight.set(roomId, p);
  return p;
}

/**
 * The room's joined members in join order, or null when the room has never
 * been read successfully (the row then shows no faces, never an error).
 * Once a room has been read, its last known members are answered at once
 * and an out-of-date entry is refreshed in the background — the sidebar
 * only ever waits for a room it has never seen.
 */
export async function getRoomMembersInJoinOrder(
  roomId: string,
  deps: MembersDeps = { getRoomState: getRoomStateAdmin, fetchEvent: fetchEventAdmin },
): Promise<string[] | null> {
  const cached = membersCache.get(roomId);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      void refreshRoomMembers(roomId, deps).catch(() => {});
    }
    return cached.members;
  }
  return refreshRoomMembers(roomId, deps);
}

/** Longest the sidebar load waits on rooms it has never read before sending
 * their rows without faces (they fill in on a later load). */
export const ROOM_FACES_BUDGET_MS = 1_500;

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
