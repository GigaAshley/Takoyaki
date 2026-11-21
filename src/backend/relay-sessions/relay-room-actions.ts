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
 * the name; when the name change is refused, an agent that controls the room
 * — one on a machine the user has access to — grants the user the right to
 * rename (and nothing more, see planRenameGrant), and the rename is tried
 * again. If another PERSON controls the room, or no agent of the user's
 * does, nothing is granted — the user gets "you can't rename this room".
 *
 * Every Matrix call goes through matrix-room-actions-client; the decision of
 * who may grant is a pure function so it tests without I/O. (The sidebar's
 * stacked faces live in relay-room-faces.ts.)
 */

import { databaseLogger } from "../utils/logger.js";
import { invalidateRoomMembers, joinedMembersInJoinOrder } from "./relay-room-faces.js";
import { userCanActAsAgent } from "./agent-access.js";
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
  | {
      kind: "grant";
      /** Agents that could make the grant, strongest first. The caller
       * picks the first one the user is allowed to act through. */
      granterCandidates: string[];
      content: Record<string, unknown>;
    }
  | { kind: "refuse"; reason: string };

/**
 * Decide whether the user can be quietly given the right to rename, and
 * what the room's permission levels become.
 *
 * The grant is the right to rename and nothing more: when the level renaming
 * needs would also let the user remove or ban members (as it does in a
 * standard private room, where both sit at the same level), the user is
 * raised just one step above the room's default instead and the room's
 * name-change requirement is lowered to meet them.
 *
 * Refused when the user isn't joined, when another person controls the
 * room, or when no agent present could make the grant. `isHuman` says
 * whether an mxid belongs to a person (a user of this instance).
 */
export function planRenameGrant(
  events: readonly RoomStateEvent[],
  userMxid: string,
  isHuman: (mxid: string) => boolean,
): RenameGrantPlan {
  const joined = joinedMembersInJoinOrder(events);
  if (!joined.includes(userMxid)) return { kind: "refuse", reason: "user_not_joined" };

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
  const current = level(userMxid);

  if (current >= needed) return { kind: "refuse", reason: "already_allowed" };

  // The user's new level, and the name-change requirement after the grant.
  // One step above the default only ever adds powers that sit exactly there.
  const oneStep = usersDefault + 1;
  const target = needed <= oneStep ? needed : Math.max(current, oneStep);
  const nameLevel = Math.min(needed, target);

  const others = joined.filter((m) => m !== userMxid);
  const controllers = others.filter((m) => level(m) >= editLevel);
  if (controllers.some(isHuman)) return { kind: "refuse", reason: "person_controls_room" };

  // A granter must be able to edit levels, can't hand out more than it holds,
  // and must reach the requirement it is changing.
  const granterCandidates = controllers
    .filter((m) => level(m) >= Math.max(needed, target))
    .sort((a, b) => level(b) - level(a));
  if (granterCandidates.length === 0) return { kind: "refuse", reason: "no_agent_controls_room" };

  const content: Record<string, unknown> = {
    ...pl,
    users: { ...usersMap, [userMxid]: target },
  };
  if (nameLevel !== needed) {
    content.events = { ...eventsMap, "m.room.name": nameLevel };
  }
  return { kind: "grant", granterCandidates, content };
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
  /** Whether this user may act through this agent: the agent lives on a
   * machine the user has access to. */
  userCanActAsAgent: (userId: string, agentMxid: string) => Promise<boolean>;
}

const defaultDeps: RoomActionDeps = {
  leaveRoomAsUser,
  setRoomNameAsUser,
  putPowerLevelsAs,
  getRoomStateAdmin,
  markRelayRoomSessionInactive,
  materializeRelayRoomSession,
  userCanActAsAgent,
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
  let granterMxid: string | undefined;
  for (const candidate of plan.granterCandidates) {
    if (await deps.userCanActAsAgent(userId, candidate)) {
      granterMxid = candidate;
      break;
    }
  }
  if (granterMxid === undefined) {
    databaseLogger.info("relay room rename refused", {
      operation: "relay_room_rename_refused",
      userId,
      roomId,
      reason: "no_agent_of_users",
    });
    return { ok: false, reason: "not_allowed" };
  }
  const grant = await deps.putPowerLevelsAs(granterMxid, roomId, plan.content);
  if (grant.ok === false) {
    databaseLogger.warn("relay room rename: grant failed", {
      operation: "relay_room_rename_grant_failed",
      userId,
      roomId,
      granterMxid,
      status: grant.status,
      error: grant.error,
    });
    // Refused by the homeserver → not allowed; anything else (outage,
    // timeout) is a failure, not a statement about who controls the room.
    return grant.status === 403
      ? { ok: false, reason: "not_allowed" }
      : { ok: false, reason: "failed", status: grant.status, error: grant.error };
  }
  databaseLogger.info("relay room rename right granted", {
    operation: "relay_room_rename_granted",
    userId,
    roomId,
    granterMxid,
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
