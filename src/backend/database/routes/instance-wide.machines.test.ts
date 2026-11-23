/**
 * Per-item machine lists: the items list scoped to a host's machine, and the
 * admin-only routes that read and change which machines an item goes to and
 * which write back.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
          (req as express.Request & { userId: string }).userId = "7";
          next();
        },
    }),
  },
}));

vi.mock("../db/index.js", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ username: "pat" }] }) }) },
}));

vi.mock("../../instance-wide/admin.js", () => ({ callerIsAdmin: vi.fn() }));

// Host row 77 is someone else's: the caller can't reach it.
vi.mock("../../ssh/host-resolver.js", () => ({
  resolveHostById: async (hostId: number) => (hostId === 77 ? null : { id: hostId, username: "ubuntu" }),
}));

const setMachines = vi.fn(async (_k: string, _n: string, lists: unknown) => lists);
const findClashes = vi.fn(async (_k: string, _n: string, _except: unknown, among: string[]) => ({
  clashes: among.includes("6") ? ["six"] : [],
  unreachable: [],
}));
vi.mock("../../instance-wide/production.js", () => ({
  getInstanceWide: () => ({
    status: async () => [
      { kind: "skill", name: "house-style", updatedAt: 1, behind: 0, conflicts: 0, hosts: [], targets: "all", writeBack: ["5"] },
      { kind: "role", name: "helper", updatedAt: 1, behind: 0, conflicts: 0, hosts: [], targets: ["6"], writeBack: [] },
    ],
    readMasterFile: async () => Buffer.from("---\ndescription: x\n---\n"),
    hostCount: async () => 1,
    offlineMachineIds: async () => new Set(["6"]),
    machinesFor: async () => ({ targets: ["5"], writeBack: [] }),
    setMachines,
    findClashes,
  }),
  getMachines: async () => [
    { machineId: "5", hostName: "five", hostRowIds: ["5", "9"] },
    { machineId: "6", hostName: "six", hostRowIds: ["6"] },
  ],
  machineForHostRow: vi.fn(),
  syncedMachineForHostRow: async (hostId: number) =>
    hostId === 5 ? { machineId: "5" } : hostId === 6 ? { machineId: "6" } : null,
}));

// Pass-through: the confirm-it's-you check is covered by its own tests.
vi.mock("../../utils/recent-auth.js", () => ({
  requireRecentAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../fleet-status/identity-visibility-gate.js", () => ({
  isIdentityVisibleToUser: () => true,
}));

vi.mock("../../utils/logger.js", () => {
  const l = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), success: vi.fn() };
  return { systemLogger: l, logger: l, sshLogger: l, databaseLogger: l, authLogger: l, apiLogger: l };
});

import { callerIsAdmin } from "../../instance-wide/admin.js";
const { default: router } = await import("./instance-wide.js");

let server: http.Server;

function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { items?: Array<Record<string, unknown>> } }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use("/instance-wide", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.clearAllMocks();
});

describe("GET /instance-wide/items?hostId", () => {
  it("lists only the items that go to that host's machine, saying which it writes back", async () => {
    (callerIsAdmin as Mock).mockResolvedValue(false);
    const res = await call("GET", "/instance-wide/items?hostId=5");
    expect(res.status).toBe(200);
    expect(res.body.items!.map((i) => i.name)).toEqual(["house-style"]);
    expect(res.body.items![0].writeBackHere).toBe(true);
    // The machine lists are for admins.
    expect(res.body.items![0]).not.toHaveProperty("targets");
    expect(res.body.items![0]).not.toHaveProperty("writeBack");
  });

  it("lists nothing for a host row that reaches no synced home folder", async () => {
    (callerIsAdmin as Mock).mockResolvedValue(true);
    const res = await call("GET", "/instance-wide/items?hostId=42");
    expect(res.body.items).toEqual([]);
  });

  it("refuses a host the caller can't reach", async () => {
    (callerIsAdmin as Mock).mockResolvedValue(false);
    const res = await call("GET", "/instance-wide/items?hostId=77");
    expect(res.status).toBe(404);
  });

  it("gives admins the machine lists", async () => {
    (callerIsAdmin as Mock).mockResolvedValue(true);
    const res = await call("GET", "/instance-wide/items?hostId=6");
    const byName = Object.fromEntries(res.body.items!.map((i) => [i.name, i]));
    expect(byName.helper).toMatchObject({ targets: ["6"], writeBack: [], writeBackHere: false });
    expect(byName["house-style"]).toMatchObject({ targets: "all", writeBack: ["5"], writeBackHere: false });
  });

  it("without hostId lists everything, as before", async () => {
    (callerIsAdmin as Mock).mockResolvedValue(true);
    const res = await call("GET", "/instance-wide/items");
    expect(res.body.items!.map((i) => i.name).sort()).toEqual(["helper", "house-style"]);
    expect(res.body.items![0]).not.toHaveProperty("writeBackHere");
  });
});

describe("machine-list routes are admin-only", () => {
  it.each([
    ["GET", "/instance-wide/machines", undefined],
    ["PUT", "/instance-wide/machines", { kind: "skill", name: "house-style", targets: ["5"], writeBack: [] }],
    ["POST", "/instance-wide/machines/preview", { kind: "skill", name: "house-style", targets: ["5", "6"] }],
  ])("%s %s refuses a non-admin", async (method, path, body) => {
    (callerIsAdmin as Mock).mockResolvedValue(false);
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(setMachines).not.toHaveBeenCalled();
  });
});

describe("machine-list routes", () => {
  beforeEach(() => (callerIsAdmin as Mock).mockResolvedValue(true));

  it("lists every fleet machine with its host rows and whether it's offline", async () => {
    const res = await call("GET", "/instance-wide/machines");
    expect(res.status).toBe(200);
    expect(res.body.machines).toEqual([
      { machineId: "5", hostName: "five", hostRowIds: ["5", "9"], offline: false },
      { machineId: "6", hostName: "six", hostRowIds: ["6"], offline: true },
    ]);
  });

  it("saves the lists", async () => {
    const res = await call("PUT", "/instance-wide/machines", {
      kind: "role",
      name: "helper",
      targets: ["5", "6"],
      writeBack: ["6"],
    });
    expect(res.status).toBe(200);
    expect(setMachines).toHaveBeenCalledWith("role", "helper", { targets: ["5", "6"], writeBack: ["6"] });
  });

  it("refuses malformed lists before touching anything", async () => {
    for (const body of [
      { kind: "role", name: "helper", targets: "some", writeBack: [] },
      { kind: "role", name: "helper", targets: [5], writeBack: [] },
      { kind: "role", name: "helper", targets: "all", writeBack: "6" },
      { kind: "nope", name: "helper", targets: "all" },
      // Both lists, always: a missing one never means "every machine" or "no write-back".
      { kind: "role", name: "helper", writeBack: ["6"] },
      { kind: "role", name: "helper", targets: ["5"] },
    ]) {
      expect((await call("PUT", "/instance-wide/machines", body)).status).toBe(400);
    }
    expect(setMachines).not.toHaveBeenCalled();
  });

  it("previews same-named folders only on the machines being added", async () => {
    const res = await call("POST", "/instance-wide/machines/preview", {
      kind: "skill",
      name: "house-style",
      targets: "all",
    });
    expect(res.status).toBe(200);
    expect(findClashes).toHaveBeenCalledWith("skill", "house-style", undefined, ["6"]);
    expect(res.body).toEqual({ clashes: ["six"], unreachable: [] });
  });

  it("previews nothing when no machine is being added", async () => {
    const res = await call("POST", "/instance-wide/machines/preview", { kind: "skill", name: "house-style", targets: ["5"] });
    expect(res.body).toEqual({ clashes: [], unreachable: [] });
    expect(findClashes).not.toHaveBeenCalled();
  });
});
