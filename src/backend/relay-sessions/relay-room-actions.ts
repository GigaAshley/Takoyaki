/**
 * relay-room-actions.ts — what a relay room's Leave and Rename… menu items
 * do.
 *
 * Leave: the user really leaves the Matrix room (sent with their own
 * token), then their sidebar row is marked inactive right away instead of
 * waiting for the observation loop's next tick.
 *
 * Rename: sets the room's real name (m.room.name) as the user, so every
 * member sees it. Rooms an agent created give invitees no right to change
 * the name; when the name change is refused for that reason, the agent that
 * controls the room grants the user just the level needed to rename, and
 * the rename is tried again. If another PERSON controls the room, nothing
 * is granted — the user gets "you can't rename this room".
 *
 * Every Matrix call goes through matrix-room-actions-client; the decision of
 * who may grant is a pure function so it tests without I/O. (The sidebar's
 * stacked faces live in relay-room-faces.ts.)
 */

import { databaseLogger } from "../utils/logger.js";
import { invalidateRoomMembers, joinedMembersInJoinOrder } from "./relay-room-faces.js";
import {
  getRoomStateAdmin,
  leaveRoomAsUser,
  putPowerLevelsAs,
  setRoomNameAsUser,
  type RoomStateEvent,
} from "../matrix/matrix-room-actions-client.js";
import {
  markRelayRoomSessionInactive,
  materializeRelayRoomSession,
} from "./relay-room-sessions-store.js";

/** Longest room name accepted (Matrix has no limit; this keeps rows sane). */
export const MAX_ROOM_NAME_LENGTH = 255;

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export type RenameGrantPlan =
  | { kind: "grant"; granterMxid: string; content: Record<string, unknown> }
  | { kind: "refuse"; reason: string };

/**
 * Decide whether the user can be quietly granted the right to rename.
 * `isHuman` says whether an mxid belongs to a person (a user of this
 * instance) rather than an agent.
 */
export function planRenameGrant(
  events: readonly RoomStateEvent[],
  userMxid: string,
  isHuman: (mxid: string) => boolean,
): RenameGrantPlan {
  const plEvent = events.find(
    (e) => e.type === "m.room.power_levels" && (e.state_key ?? "") === "",
  );
  if (!plEvent || !plEvent.content) return { kind: "refuse", reason: "no_power_levels" };
  const pl = plEvent.content;
  const usersMap =
    pl.users !== null && typeof pl.users === "object" && !Array.isArray(pl.users)
      ? (pl.users as Record<string, unknown>)
      : {};
  const eventsMap =
    pl.events !== null && typeof pl.events === "object" && !Array.isArray(pl.events)
      ? (pl.events as Record<string, unknown>)
      : {};
  const stateDefault = num(pl.state_default, 50);
  const usersDefault = num(pl.users_default, 0);
  const needed = num(eventsMap["m.room.name"], stateDefault);
  const editLevel = num(eventsMap["m.room.power_levels"], stateDefault);
  const level = (m: string) => num(usersMap[m], usersDefault);

  if (level(userMxid) >= needed) return { kind: "refuse", reason: "already_allowed" };

  const joined = joinedMembersInJoinOrder(events).filter((m) => m !== userMxid);
  const controllers = joined.filter((m) => level(m) >= editLevel);
  if (controllers.some(isHuman)) return { kind: "refuse", reason: "person_controls_room" };

  // A granter can't hand out a level above its own.
  const granters = controllers
    .filter((m) => level(m) >= needed)
    .sort((a, b) => level(b) - level(a));
  const granterMxid = granters[0];
  if (granterMxid === undefined) return { kind: "refuse", reason: "no_agent_controls_room" };

  return {
    kind: "grant",
    granterMxid,
    content: { ...pl, users: { ...usersMap, [userMxid]: needed } },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type LeaveResult = { ok: true } | { ok: false; status: number; error: string };

export interface RoomActionDeps {
  leaveRoomAsUser: typeof leaveRoomAsUser;
  setRoomNameAsUser: typeof setRoomNameAsUser;
  putPowerLevelsAs: typeof putPowerLevelsAs;
  getRoomStateAdmin: typeof getRoomStateAdmin;
  markRelayRoomSessionInactive: typeof markRelayRoomSessionInactive;
  materializeRelayRoomSession: typeof materializeRelayRoomSession;
}

const defaultDeps: RoomActionDeps = {
  leaveRoomAsUser,
  setRoomNameAsUser,
  putPowerLevelsAs,
  getRoomStateAdmin,
  markRelayRoomSessionInactive,
  materializeRelayRoomSession,
};

export async function leaveRelayRoom(
  userId: string,
  userMxid: string,
  roomId: string,
  deps: RoomActionDeps = defaultDeps,
): Promise<LeaveResult> {
  const r = await deps.leaveRoomAsUser(userMxid, roomId);
  if (r.ok === false) {
    databaseLogger.warn("relay room leave failed", {
      operation: "relay_room_leave_failed",
      userId,
      roomId,
      status: r.status,
      error: r.error,
    });
    return r;
  }
  await deps.markRelayRoomSessionInactive(userId, roomId);
  invalidateRoomMembers(roomId);
  databaseLogger.info("relay room left", { operation: "relay_room_left", userId, roomId });
  return { ok: true };
}

export type RenameResult =
  | { ok: true; granted: boolean }
  | { ok: false; reason: "not_allowed" }
  | { ok: false; reason: "failed"; status: number; error: string };

export async function renameRelayRoom(
  userId: string,
  userMxid: string,
  roomId: string,
  name: string,
  isHuman: (mxid: string) => boolean,
  deps: RoomActionDeps = defaultDeps,
): Promise<RenameResult> {
  const first = await deps.setRoomNameAsUser(userMxid, roomId, name);
  if (first.ok === true) {
    await deps.materializeRelayRoomSession(userId, roomId, name);
    databaseLogger.info("relay room renamed", {
      operation: "relay_room_renamed",
      userId,
      roomId,
      granted: false,
    });
    return { ok: true, granted: false };
  }
  if (first.ok === false && first.status !== 403) {
    databaseLogger.warn("relay room rename failed", {
      operation: "relay_room_rename_failed",
      userId,
      roomId,
      status: first.status,
      error: first.error,
    });
    return { ok: false, reason: "failed", status: first.status, error: first.error };
  }

  const state = await deps.getRoomStateAdmin(roomId);
  if (state.ok === false) {
    databaseLogger.warn("relay room rename: state read failed", {
      operation: "relay_room_rename_state_failed",
      userId,
      roomId,
      status: state.status,
      error: state.error,
    });
    return { ok: false, reason: "failed", status: state.status, error: state.error };
  }
  const plan = planRenameGrant(state.events, userMxid, isHuman);
  if (plan.kind === "refuse") {
    databaseLogger.info("relay room rename refused", {
      operation: "relay_room_rename_refused",
      userId,
      roomId,
      reason: plan.reason,
    });
    return { ok: false, reason: "not_allowed" };
  }
  const grant = await deps.putPowerLevelsAs(plan.granterMxid, roomId, plan.content);
  if (grant.ok === false) {
    databaseLogger.warn("relay room rename: grant failed", {
      operation: "relay_room_rename_grant_failed",
      userId,
      roomId,
      granterMxid: plan.granterMxid,
      status: grant.status,
      error: grant.error,
    });
    return { ok: false, reason: "not_allowed" };
  }
  databaseLogger.info("relay room rename right granted", {
    operation: "relay_room_rename_granted",
    userId,
    roomId,
    granterMxid: plan.granterMxid,
  });
  const second = await deps.setRoomNameAsUser(userMxid, roomId, name);
  if (second.ok === false) {
    databaseLogger.warn("relay room rename failed after grant", {
      operation: "relay_room_rename_failed_after_grant",
      userId,
      roomId,
      status: second.status,
      error: second.error,
    });
    return second.status === 403
      ? { ok: false, reason: "not_allowed" }
      : { ok: false, reason: "failed", status: second.status, error: second.error };
  }
  await deps.materializeRelayRoomSession(userId, roomId, name);
  databaseLogger.info("relay room renamed", {
    operation: "relay_room_renamed",
    userId,
    roomId,
    granted: true,
  });
  return { ok: true, granted: true };
}
