import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  databaseLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../matrix/matrix-room-actions-client.js", () => ({
  getRoomStateAdmin: vi.fn(),
  fetchEventAdmin: vi.fn(),
  leaveRoomAsUser: vi.fn(),
  putPowerLevelsAs: vi.fn(),
  setRoomNameAsUser: vi.fn(),
}));
vi.mock("../database/db/index.js", () => ({ db: {} }));
vi.mock("../database/db/schema.js", () => ({ users: {} }));
vi.mock("./agent-access.js", () => ({ userCanActAsAgent: vi.fn() }));
vi.mock("./relay-room-sessions-store.js", () => ({
  markRelayRoomSessionInactive: vi.fn(),
  materializeRelayRoomSession: vi.fn(),
}));

import {
  leaveRelayRoom,
  planRenameGrant,
  renameRelayRoom,
  type RoomActionDeps,
} from "./relay-room-actions.js";
import {
  __resetRoomMembersCacheForTests,
  getRoomMembersInJoinOrder,
  invalidateRoomMembers,
  joinedMembersInJoinOrder,
  pickRoomFaces,
} from "./relay-room-faces.js";
import type { RoomStateEvent } from "../matrix/matrix-room-actions-client.js";

const ME = "@me_human:hs";
const AGENT = "@finch:hs";
const AGENT2 = "@bilbo:hs";
const PERSON = "@zed_human:hs";

function member(mxid: string, ts: number, membership = "join"): RoomStateEvent {
  return { type: "m.room.member", state_key: mxid, origin_server_ts: ts, content: { membership } };
}
function powerLevels(content: Record<string, unknown>): RoomStateEvent {
  return { type: "m.room.power_levels", state_key: "", content };
}
// An agent-created private_chat room: the agent at 100, invitees at 0.
function agentRoom(extra: RoomStateEvent[] = []): RoomStateEvent[] {
  return [
    member(AGENT, 100),
    member(ME, 200),
    powerLevels({ users: { [AGENT]: 100 }, users_default: 0, state_default: 50, events: {} }),
    ...extra,
  ];
}
const humans = new Set([ME, PERSON]);
const isHuman = (m: string) => humans.has(m);

function makeDeps(over: Partial<RoomActionDeps> = {}): RoomActionDeps {
  return {
    leaveRoomAsUser: vi.fn().mockResolvedValue({ ok: true }),
    setRoomNameAsUser: vi.fn().mockResolvedValue({ ok: true }),
    putPowerLevelsAs: vi.fn().mockResolvedValue({ ok: true }),
    getRoomStateAdmin: vi.fn().mockResolvedValue({ ok: true, events: agentRoom() }),
    markRelayRoomSessionInactive: vi.fn().mockResolvedValue(undefined),
    materializeRelayRoomSession: vi.fn().mockResolvedValue(undefined),
    userCanActAsAgent: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe("joinedMembersInJoinOrder", () => {
  it("lists joined members oldest join first, skipping left/invited", () => {
    const events = [
      member(PERSON, 300),
      member(AGENT, 100),
      member("@gone:hs", 50, "leave"),
      member("@maybe:hs", 60, "invite"),
      member(ME, 200),
      powerLevels({}),
    ];
    expect(joinedMembersInJoinOrder(events)).toEqual([AGENT, ME, PERSON]);
  });
});

describe("planRenameGrant", () => {
  it("grants just the right to rename: one step above the default, name requirement lowered to meet it", () => {
    // Standard private room: renaming needs 50, which is also the level for
    // removing and banning — the user must not get that.
    const plan = planRenameGrant(agentRoom(), ME, isHuman);
    expect(plan).toEqual({
      kind: "grant",
      granterCandidates: [AGENT],
      content: expect.objectContaining({
        users: { [AGENT]: 100, [ME]: 1 },
        events: { "m.room.name": 1 },
        state_default: 50,
      }),
    });
  });

  it("when renaming already sits one step above the default, raises the user to it and leaves the rule alone", () => {
    const events = [
      member(AGENT, 1),
      member(ME, 2),
      powerLevels({ users: { [AGENT]: 100 }, events: { "m.room.name": 1 } }),
    ];
    const plan = planRenameGrant(events, ME, isHuman);
    expect(plan.kind).toBe("grant");
    if (plan.kind === "grant") {
      expect((plan.content.users as Record<string, number>)[ME]).toBe(1);
      expect(plan.content.events).toEqual({ "m.room.name": 1 });
    }
  });

  it("keeps a user's existing higher level", () => {
    const events = [
      member(AGENT, 1),
      member(ME, 2),
      powerLevels({ users: { [AGENT]: 100, [ME]: 10 } }),
    ];
    const plan = planRenameGrant(events, ME, isHuman);
    expect(plan.kind === "grant" && plan.content).toMatchObject({
      users: { [ME]: 10 },
      events: { "m.room.name": 10 },
    });
  });

  it("refuses when the user isn't joined (removed, banned, only invited)", () => {
    const events = [
      member(AGENT, 1),
      member(ME, 2, "leave"),
      powerLevels({ users: { [AGENT]: 100 } }),
    ];
    expect(planRenameGrant(events, ME, isHuman)).toEqual({ kind: "refuse", reason: "user_not_joined" });
  });

  it("refuses when another person controls the room", () => {
    const events = [
      member(PERSON, 1),
      member(AGENT, 2),
      member(ME, 3),
      powerLevels({ users: { [PERSON]: 100, [AGENT]: 100 } }),
    ];
    expect(planRenameGrant(events, ME, isHuman)).toEqual({
      kind: "refuse",
      reason: "person_controls_room",
    });
  });

  it("refuses when no member present can grant", () => {
    const events = [member(AGENT, 1), member(ME, 2), powerLevels({ users: { "@absent:hs": 100 } })];
    expect(planRenameGrant(events, ME, isHuman).kind).toBe("refuse");
  });

  it("lists possible granters strongest first", () => {
    const events = [
      member(AGENT2, 1),
      member(AGENT, 2),
      member(ME, 3),
      powerLevels({ users: { [AGENT2]: 60, [AGENT]: 100 } }),
    ];
    const plan = planRenameGrant(events, ME, isHuman);
    expect(plan.kind === "grant" && plan.granterCandidates).toEqual([AGENT, AGENT2]);
  });
});

describe("pickRoomFaces", () => {
  const humansMap = new Map([
    [PERSON, { displayName: "zed", userId: "u-zed", avatarPath: "zed.webp" }],
    [ME, { displayName: "me", userId: "u-me", avatarPath: null }],
  ]);

  it("never shows the viewer, takes the first two others, counts the rest", () => {
    const faces = pickRoomFaces([AGENT, ME, PERSON, AGENT2], ME, humansMap);
    expect(faces.othersCount).toBe(3);
    expect(faces.faces).toEqual([
      { mxid: AGENT, kind: "agent", name: "finch" },
      { mxid: PERSON, kind: "human", name: "zed", userId: "u-zed", avatarPath: "zed.webp" },
    ]);
  });

  it("one other member → one face", () => {
    const faces = pickRoomFaces([ME, PERSON], ME, humansMap);
    expect(faces.faces.map((f) => f.mxid)).toEqual([PERSON]);
    expect(faces.othersCount).toBe(1);
  });
});

const noFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, error: "none" });

describe("getRoomMembersInJoinOrder", () => {
  beforeEach(() => __resetRoomMembersCacheForTests());

  it("reads the room once per TTL and shares in-flight reads", async () => {
    const getRoomState = vi.fn().mockResolvedValue({ ok: true, events: agentRoom() });
    const [a, b] = await Promise.all([
      getRoomMembersInJoinOrder("!r:hs", { getRoomState, fetchEvent: noFetch }),
      getRoomMembersInJoinOrder("!r:hs", { getRoomState, fetchEvent: noFetch }),
    ]);
    expect(a).toEqual([AGENT, ME]);
    expect(b).toEqual([AGENT, ME]);
    await getRoomMembersInJoinOrder("!r:hs", { getRoomState, fetchEvent: noFetch });
    expect(getRoomState).toHaveBeenCalledTimes(1);
  });

  it("orders by when members really joined, not their latest profile change", async () => {
    // AGENT joined at 100 then changed its name at 900; ME joined at 200.
    const events: RoomStateEvent[] = [
      { ...member(AGENT, 900), event_id: "$agent-rename", unsigned: { replaces_state: "$agent-join" } },
      { ...member(ME, 200), event_id: "$me-join", unsigned: { replaces_state: "$me-invite" } },
    ];
    const fetchEvent = vi.fn(async (id: string) => {
      if (id === "$agent-join") return { ok: true as const, event: { ...member(AGENT, 100), unsigned: { replaces_state: "$agent-invite" } } };
      if (id === "$agent-invite") return { ok: true as const, event: member(AGENT, 50, "invite") };
      if (id === "$me-invite") return { ok: true as const, event: member(ME, 150, "invite") };
      return { ok: false as const, status: 404, error: "none" };
    });
    const getRoomState = vi.fn().mockResolvedValue({ ok: true, events });
    expect(await getRoomMembersInJoinOrder("!p:hs", { getRoomState, fetchEvent })).toEqual([AGENT, ME]);
    expect(fetchEvent).toHaveBeenCalledTimes(3);
    // Answers are remembered: a later refresh of the room fetches nothing new.
    invalidateRoomMembers("!p:hs");
    await getRoomMembersInJoinOrder("!p:hs", { getRoomState, fetchEvent });
    await new Promise((r) => setTimeout(r, 0));
    expect(getRoomState).toHaveBeenCalledTimes(2);
    expect(fetchEvent).toHaveBeenCalledTimes(3);
  });

  it("answers an out-of-date room at once and refreshes it in the background", async () => {
    const getRoomState = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: agentRoom() })
      .mockResolvedValueOnce({ ok: true, events: [...agentRoom(), member(PERSON, 300)] });
    expect(await getRoomMembersInJoinOrder("!s:hs", { getRoomState, fetchEvent: noFetch })).toEqual([AGENT, ME]);
    invalidateRoomMembers("!s:hs");
    // Out of date: the last known members come back straight away...
    expect(await getRoomMembersInJoinOrder("!s:hs", { getRoomState, fetchEvent: noFetch })).toEqual([AGENT, ME]);
    await new Promise((r) => setTimeout(r, 0));
    // ...and the background refresh has landed for the next read.
    expect(await getRoomMembersInJoinOrder("!s:hs", { getRoomState, fetchEvent: noFetch })).toEqual([AGENT, ME, PERSON]);
  });

  it("a walk cut short by a failed lookup isn't remembered", async () => {
    const events: RoomStateEvent[] = [
      { ...member(AGENT, 900), event_id: "$a2", unsigned: { replaces_state: "$a1" } },
      { ...member(ME, 200), event_id: "$m1" },
    ];
    const fetchEvent = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, error: "blip" })
      .mockResolvedValueOnce({ ok: true, event: member(AGENT, 100) });
    const getRoomState = vi.fn().mockResolvedValue({ ok: true, events });
    expect(await getRoomMembersInJoinOrder("!w:hs", { getRoomState, fetchEvent })).toEqual([ME, AGENT]);
    invalidateRoomMembers("!w:hs");
    await getRoomMembersInJoinOrder("!w:hs", { getRoomState, fetchEvent });
    await new Promise((r) => setTimeout(r, 0));
    expect(await getRoomMembersInJoinOrder("!w:hs", { getRoomState, fetchEvent })).toEqual([AGENT, ME]);
  });

  it("returns null when the room can't be read", async () => {
    const getRoomState = vi.fn().mockResolvedValue({ ok: false, status: 502, error: "x" });
    expect(await getRoomMembersInJoinOrder("!r:hs", { getRoomState, fetchEvent: noFetch })).toBeNull();
  });
});

describe("leaveRelayRoom", () => {
  it("leaves as the user, then marks the row inactive", async () => {
    const deps = makeDeps();
    expect(await leaveRelayRoom("u-me", ME, "!r:hs", deps)).toEqual({ ok: true });
    expect(deps.leaveRoomAsUser).toHaveBeenCalledWith(ME, "!r:hs");
    expect(deps.markRelayRoomSessionInactive).toHaveBeenCalledWith("u-me", "!r:hs");
  });

  it("keeps the row when Matrix refuses", async () => {
    const deps = makeDeps({
      leaveRoomAsUser: vi.fn().mockResolvedValue({ ok: false, status: 502, error: "x" }),
    });
    expect((await leaveRelayRoom("u-me", ME, "!r:hs", deps)).ok).toBe(false);
    expect(deps.markRelayRoomSessionInactive).not.toHaveBeenCalled();
  });
});

describe("renameRelayRoom", () => {
  it("renames directly when the user already may", async () => {
    const deps = makeDeps();
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toEqual({
      ok: true,
      granted: false,
    });
    expect(deps.putPowerLevelsAs).not.toHaveBeenCalled();
    expect(deps.materializeRelayRoomSession).toHaveBeenCalledWith("u-me", "!r:hs", "Plans");
  });

  it("quietly grants in an agent-created room, then renames", async () => {
    const setName = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps({ setRoomNameAsUser: setName });
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toEqual({
      ok: true,
      granted: true,
    });
    expect(deps.userCanActAsAgent).toHaveBeenCalledWith("u-me", AGENT);
    expect(deps.putPowerLevelsAs).toHaveBeenCalledWith(
      AGENT,
      "!r:hs",
      expect.objectContaining({ users: { [AGENT]: 100, [ME]: 1 } }),
    );
    expect(setName).toHaveBeenCalledTimes(2);
  });

  it("never acts through an agent that isn't the user's", async () => {
    const deps = makeDeps({
      setRoomNameAsUser: vi.fn().mockResolvedValue({ ok: false, status: 403, error: "forbidden" }),
      userCanActAsAgent: vi.fn().mockResolvedValue(false),
    });
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(deps.putPowerLevelsAs).not.toHaveBeenCalled();
  });

  it("a grant that fails for an outage is a failure, not 'not allowed'", async () => {
    const deps = makeDeps({
      setRoomNameAsUser: vi.fn().mockResolvedValue({ ok: false, status: 403, error: "forbidden" }),
      putPowerLevelsAs: vi.fn().mockResolvedValue({ ok: false, status: 504, error: "timeout" }),
    });
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("says not allowed when a person controls the room, granting nothing", async () => {
    const deps = makeDeps({
      setRoomNameAsUser: vi.fn().mockResolvedValue({ ok: false, status: 403, error: "forbidden" }),
      getRoomStateAdmin: vi.fn().mockResolvedValue({
        ok: true,
        events: [member(PERSON, 1), member(ME, 2), powerLevels({ users: { [PERSON]: 100 } })],
      }),
    });
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(deps.putPowerLevelsAs).not.toHaveBeenCalled();
  });

  it("reports other failures as failed, not as not-allowed", async () => {
    const deps = makeDeps({
      setRoomNameAsUser: vi.fn().mockResolvedValue({ ok: false, status: 502, error: "x" }),
    });
    expect(await renameRelayRoom("u-me", ME, "!r:hs", "Plans", isHuman, deps)).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });
});
