/**
 * Role archive through the machine's front door: the preflight (role-contents,
 * who archiving it would take) and the archive itself (role-archive, with the
 * agents the user confirmed). The front door's own behaviour is
 * fleet-change.test.sh's; the supervisor's, agent-supervisor-role-archive.test.sh's.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

let mockUserId: string | null = "1";
vi.mock("../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
          if (mockUserId === null) return res.status(401).json({ error: "Unauthorized" });
          (req as express.Request & { userId: string }).userId = mockUserId;
          next();
        },
    }),
  },
}));
vi.mock("../../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  sshLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../fleet-change/front-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fleet-change/front-door.js")>()),
  submitFrontDoor: vi.fn(),
  submitAndFollow: vi.fn(),
}));
vi.mock("../../sharing/host-conn.js", () => {
  class HttpError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { HttpError, withHost: vi.fn() };
});
vi.mock("../../instance-wide/production.js", () => ({ getInstanceWide: vi.fn(), syncedMachineForHostRow: vi.fn() }));
vi.mock("../../ssh/host-resolver.js", () => ({ resolveHostById: vi.fn() }));

import { submitAndFollow, submitFrontDoor } from "../../fleet-change/front-door.js";
import { withHost } from "../../sharing/host-conn.js";
import { getInstanceWide, syncedMachineForHostRow } from "../../instance-wide/production.js";
import { resolveHostById } from "../../ssh/host-resolver.js";
import router from "./role-archive.js";

function call(server: http.Server, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : {} }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let server: http.Server;
const conn = { fake: "conn" };

function serve(base: string, router: express.Router): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(base, router);
  server = app.listen(0);
  return new Promise((r) => server.once("listening", () => r()));
}

function answer(outcome: Record<string, unknown>): void {
  const impl = async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => ({ id: o.id, seq: 1, ...outcome });
  (submitFrontDoor as Mock).mockImplementation(impl);
  (submitAndFollow as Mock).mockImplementation(impl);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId = "1";
  (withHost as Mock).mockImplementation(async (_h: number, _u: string, fn: (c: unknown) => Promise<unknown>) => fn(conn));
  answer({ state: "done", result: {} });
});

afterEach(() => server?.close());

describe("role archive", () => {
  beforeEach(() => serve("/roles", router));

  it("preflight asks the machine who holds the role", async () => {
    answer({ state: "done", result: { role: "eng", displayName: "Engineer", agents: [{ name: "ann", displayName: "Ann", task: "" }] } });
    const r = await call(server, "GET", "/roles/eng/archive-preflight?hostId=5");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: { agents: [{ name: "ann" }] } });
    expect(submitAndFollow).toHaveBeenCalledWith(conn, "role-contents", { name: "eng" }, expect.objectContaining({ hostId: 5, totalS: 30 }));
  });

  it("archives with the agents the user confirmed", async () => {
    answer({ state: "done", result: { role: "eng", claimed: ["ann"] }, finishing: { pending: ["ann", "eng"] } });
    const r = await call(server, "POST", "/roles/eng/archive", { hostId: 5, expected: { agents: ["ann"] }, requestId: "r1" });
    expect(r.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "role-archive", { name: "eng", expected: { agents: ["ann"] } }, { id: "r1", hostId: 5, by: "1" });
  });

  it("passes on a changed list with the machine's current one", async () => {
    answer({ state: "refused", code: "contents_changed", reason: "the agents holding this role changed since you looked; check the list again",
      result: { role: "eng", agents: [{ name: "ann" }, { name: "bob" }] } });
    const r = await call(server, "POST", "/roles/eng/archive", { hostId: 5, expected: { agents: ["ann"] } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "contents_changed", result: { agents: [{ name: "ann" }, { name: "bob" }] } });
  });

  it("needs the confirmed list", async () => {
    expect((await call(server, "POST", "/roles/eng/archive", { hostId: 5 })).status).toBe(400);
    expect((await call(server, "POST", "/roles/eng/archive", { hostId: 5, expected: { agents: ["Bad Name"] } })).status).toBe(400);
    expect((await call(server, "POST", "/roles/Eng/archive", { hostId: 5, expected: { agents: [] } })).status).toBe(400);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("refuses a shared role on a machine it goes to", async () => {
    (getInstanceWide as Mock).mockReturnValue({ isSharedOn: vi.fn().mockResolvedValue(true) });
    (resolveHostById as Mock).mockResolvedValue({ username: "ubuntu" });
    (syncedMachineForHostRow as Mock).mockResolvedValue({ machineId: "m1" });
    const r = await call(server, "POST", "/roles/eng/archive", { hostId: 5, expected: { agents: [] } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "instance_wide" });
    expect(submitFrontDoor).not.toHaveBeenCalled();
    (getInstanceWide as Mock).mockReturnValue(null);
  });

  it("checks the preflight's host id", async () => {
    expect((await call(server, "GET", "/roles/eng/archive-preflight")).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });
});
