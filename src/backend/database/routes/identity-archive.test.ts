/**
 * POST /identities/:key/archive — a request to the machine's front door
 * (fleet-change agent-archive). Auth, the machine connection and the front
 * door are mocked; the front door's own behaviour is fleet-change.test.sh's.
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

import { submitAndFollow, submitFrontDoor } from "../../fleet-change/front-door.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import router from "./identity-archive.js";

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

describe("POST /identities/:key/archive", () => {
  beforeEach(() => serve("/identities", router));

  it("sends the archive to the front door with the click's request id", async () => {
    answer({ state: "done", result: { name: "alpha", claimed: ["alpha"] }, finishing: { pending: ["alpha"] } });
    const r = await call(server, "POST", "/identities/alpha/archive", { hostId: 5, requestId: "click-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, requestId: "click-1", finishing: { pending: ["alpha"] } });
    expect(withHost).toHaveBeenCalledWith(5, "1", expect.any(Function));
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-archive", { name: "alpha" }, { id: "click-1", hostId: 5, by: "1" });
  });

  it("passes a refusal on with the machine's reason", async () => {
    answer({ state: "refused", code: "archive_slot_taken", reason: "an archived agent named 'alpha' is already in the archive" });
    const r = await call(server, "POST", "/identities/alpha/archive", { hostId: 5 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "archive_slot_taken", error: "an archived agent named 'alpha' is already in the archive" });
  });

  it("answers 202 while it's still waiting its turn", async () => {
    answer({ state: "pending", stage: "queued" });
    const r = await call(server, "POST", "/identities/alpha/archive", { hostId: 5 });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ pending: true });
  });

  it("says the machine is updating when the front door isn't there yet", async () => {
    (submitFrontDoor as Mock).mockResolvedValue({ state: "not_installed", id: "x" });
    const r = await call(server, "POST", "/identities/alpha/archive", { hostId: 5 });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "updating" });
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "POST", "/identities/alpha/archive", {})).status).toBe(400);
    expect((await call(server, "POST", "/identities/alpha/archive", { hostId: -1 })).status).toBe(400);
    expect((await call(server, "POST", "/identities/Bad.Key/archive", { hostId: 5 })).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });

  it("maps an unknown host and an unreachable one", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(404, "Host not found"));
    expect((await call(server, "POST", "/identities/alpha/archive", { hostId: 5 })).status).toBe(404);
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await call(server, "POST", "/identities/alpha/archive", { hostId: 5 })).status).toBe(504);
  });

  it("refuses an unauthenticated caller", async () => {
    mockUserId = null;
    expect((await call(server, "POST", "/identities/alpha/archive", { hostId: 5 })).status).toBe(401);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });
});
