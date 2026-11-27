import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetMachineChangesForTest,
  afterMachineSettles,
  changesFor,
  getMachineChanges,
  markFor,
  setMachineChanges,
  type MachineChange,
} from "./machine-changes-store";

const c = (over: Partial<MachineChange>): MachineChange => ({
  id: "r1",
  kind: "agent-project",
  state: "waiting",
  target: { type: "agent", name: "finch" },
  at: 1,
  mine: false,
  ...over,
});

beforeEach(() => __resetMachineChangesForTest());

describe("machine-changes store", () => {
  it("keeps one list per machine, replaced whole", () => {
    setMachineChanges("1", [c({})]);
    setMachineChanges("2", [c({ id: "r2" })]);
    setMachineChanges("1", []);
    expect(getMachineChanges().get("1")).toEqual([]);
    expect(getMachineChanges().get("2")?.map((x) => x.id)).toEqual(["r2"]);
  });

  it("finds a thing's entries by machine, kind of thing and name (case-folded)", () => {
    setMachineChanges("1", [c({}), c({ id: "r2", target: { type: "app", name: "finch" } })]);
    expect(changesFor(getMachineChanges(), 1, "agent", "Finch").map((x) => x.id)).toEqual(["r1"]);
    expect(changesFor(getMachineChanges(), 2, "agent", "finch")).toEqual([]);
  });

  describe("markFor", () => {
    it("a failure of this person's comes first, then a waiting archive, then the latest move", () => {
      const move1 = c({ id: "m1", to: { project: "a" } });
      const move2 = c({ id: "m2", kind: "agent-pin", to: { pinned: true } });
      const archive = c({ id: "a", kind: "agent-archive", state: "running" });
      const failed = c({ id: "f", state: "refused", mine: true, reason: "that project is gone" });
      expect(markFor([move1, move2])).toEqual({ kind: "moving", change: move2 });
      expect(markFor([move1, archive])).toEqual({ kind: "archiving", change: archive });
      expect(markFor([move1, archive, failed])).toEqual({ kind: "failed", change: failed });
    });

    it("renames and window edits get no waiting mark; an agent coming back isn't a mark either", () => {
      expect(markFor([c({ kind: "agent-edit" }), c({ kind: "project-rename" })])).toBeNull();
      expect(markFor([c({ kind: "agent-unarchive", state: "returning" })])).toBeNull();
    });

    it("an edit that failed does get the failure mark", () => {
      expect(markFor([c({ kind: "agent-edit", state: "failed", mine: true })])?.kind).toBe("failed");
    });
  });

  describe("afterMachineSettles", () => {
    it("done once the report has listed it open and then doesn't", async () => {
      const ended = afterMachineSettles(1, "r1");
      setMachineChanges("1", [c({})]);
      setMachineChanges("1", [c({ state: "running" })]);
      setMachineChanges("1", []);
      await expect(ended).resolves.toBe("done");
    });

    it("keeps waiting while the report hasn't listed it yet", async () => {
      let settled = false;
      void afterMachineSettles(1, "r1").then(() => {
        settled = true;
      });
      setMachineChanges("1", [c({ id: "other" })]);
      await Promise.resolve();
      expect(settled).toBe(false);
    });

    it("failed when the report shows it refused or failed", async () => {
      setMachineChanges("1", [c({})]);
      const ended = afterMachineSettles(1, "r1");
      setMachineChanges("1", [c({ state: "refused", mine: true, reason: "nope" })]);
      await expect(ended).resolves.toBe("failed");
    });

    it("a new agent left out of its project counts as done (it was made)", async () => {
      const ended = afterMachineSettles(1, "r1");
      setMachineChanges("1", [c({ state: "unfiled", mine: true })]);
      await expect(ended).resolves.toBe("done");
    });
  });
});
