// instance-wide role guard — fails CLOSED when the write names no host.
import { describe, it, expect, vi, beforeEach } from "vitest";

const engine = {
  isInstanceWide: vi.fn(async () => true),
  isSharedOn: vi.fn(async () => true),
  writesBackFrom: vi.fn(async () => false),
  markAdminSourced: vi.fn(),
  requestSync: vi.fn(),
};
// The synced-home lookup; it reads the row's username through rowUsername.
const machineForHostRow = vi.fn();
vi.mock("./production.js", () => ({
  getInstanceWide: vi.fn(() => engine),
  syncedMachineForHostRow: (hostId: number, rowUsername: () => Promise<unknown>) =>
    machineForHostRow(hostId, rowUsername),
}));
vi.mock("../ssh/host-resolver.js", () => ({
  resolveHostById: async (hostId: number) => ({ id: hostId, username: "ubuntu" }),
}));
const callerIsAdmin = vi.fn();
vi.mock("./admin.js", () => ({
  callerIsAdmin: (...a: unknown[]) => callerIsAdmin(...a),
}));
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({
  sshLogger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() },
}));

import { checkInstanceWideRoleWrite } from "./role-guard.js";

const MACHINE = { machineId: "6", hostRowIds: ["6"], local: true };

beforeEach(() => {
  vi.clearAllMocks();
  engine.isInstanceWide.mockResolvedValue(true);
  engine.isSharedOn.mockResolvedValue(true);
  engine.writesBackFrom.mockResolvedValue(false);
  machineForHostRow.mockResolvedValue(MACHINE);
});

describe("checkInstanceWideRoleWrite — missing hostId", () => {
  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["NaN", Number.NaN],
    ["negative", -3],
  ])("refuses a %s hostId for a non-admin, logs instance_wide_guard_missing_host", async (_l, hostId) => {
    callerIsAdmin.mockResolvedValue(false);
    const res = await checkInstanceWideRoleWrite("u1", hostId as number | undefined, "box-maintainer");
    expect(res).toEqual({ verdict: "refuse" });
    expect(machineForHostRow).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: "instance_wide_guard_missing_host", userId: "u1", role: "box-maintainer" }),
    );
  });

  it("refuses a missing hostId even for an admin (no silent local-machine sync)", async () => {
    callerIsAdmin.mockResolvedValue(true);
    const res = await checkInstanceWideRoleWrite("admin", undefined, "box-maintainer");
    expect(res).toEqual({ verdict: "refuse" });
    expect(engine.markAdminSourced).not.toHaveBeenCalled();
  });

  it("refuses a missing hostId even when the role is not instance-wide", async () => {
    engine.isInstanceWide.mockResolvedValue(false);
    const res = await checkInstanceWideRoleWrite("u1", undefined, "plain-role");
    expect(res).toEqual({ verdict: "refuse" });
  });
});

describe("checkInstanceWideRoleWrite — with hostId", () => {
  it("non-admin is refused on an instance-wide role of a synced host", async () => {
    callerIsAdmin.mockResolvedValue(false);
    expect(await checkInstanceWideRoleWrite("u1", 6, "box-maintainer")).toEqual({ verdict: "refuse" });
    expect(machineForHostRow).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it("admin write on a synced host returns admin + marks the machine", async () => {
    callerIsAdmin.mockResolvedValue(true);
    expect(await checkInstanceWideRoleWrite("admin", 6, "box-maintainer")).toEqual({ verdict: "admin", machineId: "6" });
    expect(engine.markAdminSourced).toHaveBeenCalledWith("6", "role", "box-maintainer");
  });

  it("allows when the role is not instance-wide", async () => {
    engine.isInstanceWide.mockResolvedValue(false);
    expect(await checkInstanceWideRoleWrite("u1", 6, "plain-role")).toEqual({ verdict: "allow" });
  });

  it("allows when the host is not part of instance-wide sync", async () => {
    machineForHostRow.mockResolvedValue(null);
    expect(await checkInstanceWideRoleWrite("u1", 42, "box-maintainer")).toEqual({ verdict: "allow" });
  });

  it("allows anyone when the role doesn't go to this machine (a same-named role is the machine's own)", async () => {
    callerIsAdmin.mockResolvedValue(false);
    engine.isSharedOn.mockResolvedValue(false);
    expect(await checkInstanceWideRoleWrite("u1", 6, "box-maintainer")).toEqual({ verdict: "allow" });
    expect(engine.isSharedOn).toHaveBeenCalledWith("role", "box-maintainer", "6");
  });

  it("lets a non-admin write on a machine that writes the role back", async () => {
    callerIsAdmin.mockResolvedValue(false);
    engine.writesBackFrom.mockResolvedValue(true);
    expect(await checkInstanceWideRoleWrite("u1", 6, "box-maintainer")).toEqual({ verdict: "writeBack", machineId: "6" });
    expect(engine.markAdminSourced).not.toHaveBeenCalled();
  });
});
