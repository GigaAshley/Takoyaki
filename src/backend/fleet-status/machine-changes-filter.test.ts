/**
 * machine-changes-filter.test.ts — what each person sees of a machine's open changes:
 * only things they can see; notices only for the person they're for, once; a move's
 * hidden destination never named; gate-only fields never on the wire.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  databaseLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  systemLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { filterAppFrame, type AppFrameFilterCtx } from "./app-frame-filter.js";
import { makeMachineChangesFrame, type GatedMachineChange, type MachineChange } from "./wire-protocol.js";

const allow = vi.fn(async () => true);

function change(over: Partial<GatedMachineChange>): GatedMachineChange {
  return {
    id: "r1",
    kind: "agent-project",
    state: "waiting",
    target: { type: "agent", name: "finch" },
    at: 1,
    mine: false,
    audience: null,
    ...over,
  };
}

async function view(
  changes: GatedMachineChange[],
  opts: { userId?: string; username?: string | null; seen?: string[]; asking?: string[]; hostAllowed?: boolean } = {},
): Promise<MachineChange[] | null> {
  const ctx: AppFrameFilterCtx = {
    userId: opts.userId ?? "u1",
    resolveHostOwnerById: async (h) => ({ hostIdNum: Number(h), hostUserId: "owner" }),
    resolveIdentityGate: async () => true,
    resolveCallerUsername: async () => (opts.username === undefined ? "ann" : opts.username),
    noticeSeen: (_u, _h, key) => (opts.seen ?? []).includes(key),
    beingAsked: (_h, id) => (opts.asking ?? []).includes(id),
  };
  const check = opts.hostAllowed === false ? vi.fn(async () => false) : allow;
  const out = await filterAppFrame(makeMachineChangesFrame("7", changes), ctx, undefined, check);
  if (out === null) return null;
  expect(out.type).toBe("machine-changes");
  return (out as { changes: MachineChange[] }).changes;
}

describe("machine-changes filter", () => {
  it("drops the whole frame for a machine the person can't reach", async () => {
    expect(await view([change({})], { hostAllowed: false })).toBeNull();
  });

  it("shows waiting changes to everyone who can see the thing, and nobody else", async () => {
    const out = await view([
      change({ id: "a", audience: null }),
      change({ id: "b", audience: ["ann", "bob"] }),
      change({ id: "c", audience: ["bob"] }),
    ]);
    expect(out?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("no username to check against: the gate stays open (as for every other frame)", async () => {
    expect((await view([change({ audience: ["bob"] })], { username: null }))?.length).toBe(1);
  });

  it("marks the person's own changes and strips every gate-only field", async () => {
    const [mine] = (await view([change({ byUser: "u1", toAudience: null, to: { project: "garden" } })]))!;
    expect(mine).toEqual({
      id: "r1",
      kind: "agent-project",
      state: "waiting",
      target: { type: "agent", name: "finch" },
      at: 1,
      mine: true,
      to: { project: "garden" },
    });
  });

  it("never names a destination hidden from them", async () => {
    const [c] = (await view([change({ to: { project: "secret" }, toAudience: ["bob"] })]))!;
    expect(c.to).toEqual({ hidden: true });
    const [p] = (await view([change({ kind: "agent-pin", to: { pinned: true } })]))!;
    expect(p.to).toEqual({ pinned: true });
  });

  it("refusals, failures and un-filed agents go only to whoever asked, once, and not while their answer is on its way", async () => {
    const notices = [
      change({ id: "f1", state: "refused", byUser: "u1", reason: "that project is gone" }),
      change({ id: "f2", state: "failed", byUser: "u2" }),
      change({ id: "f3", state: "unfiled", byUser: "u1" }),
      change({ id: "f4", state: "refused", byAgent: "wren" }),
      change({ id: "f5", state: "refused", byUser: "u1" }),
      change({ id: "f6", state: "refused", byUser: "u1" }),
    ];
    const out = await view(notices, { seen: ["f5"], asking: ["f6"] });
    expect(out?.map((c) => c.id)).toEqual(["f1", "f3"]);
    expect(out?.[0].reason).toBe("that project is gone");
  });

  it("a stuck archive goes to whoever archived it — or, with no person behind it, to everyone who can see it", async () => {
    const out = await view(
      [
        change({ id: "s1", state: "stuck", kind: "agent-archive", byUser: "u1" }),
        change({ id: "s2", state: "stuck", kind: "agent-archive", byUser: "u2" }),
        change({ id: "s3", state: "stuck", kind: "agent-archive", byAgent: "wren" }),
        change({ id: "s4", state: "stuck", kind: "agent-archive" }),
        change({ id: "s5", state: "stuck", kind: "agent-archive", audience: ["bob"] }),
        change({ id: "s6", state: "stuck", kind: "agent-archive", byUser: "u1" }),
      ],
      { seen: ["s6:stuck", "s4"] },
    );
    expect(out?.map((c) => c.id)).toEqual(["s1", "s3", "s4"]);
  });

  it("where an agent coming back lands is never named to someone who can't see that project", async () => {
    const [c] = (await view([
      change({ state: "returning", kind: "agent-unarchive", card: { displayName: "Wren", project: "secret" }, cardAudience: ["bob"] }),
    ]))!;
    expect(c.card).toEqual({ displayName: "Wren", project: null });
    expect(c).not.toHaveProperty("cardAudience");
  });

  it("agents coming back show to everyone who can see them", async () => {
    const out = await view([
      change({ id: "u", state: "returning", kind: "agent-unarchive", card: { displayName: "Wren", project: null } }),
    ]);
    expect(out?.[0].card).toEqual({ displayName: "Wren", project: null });
  });
});
