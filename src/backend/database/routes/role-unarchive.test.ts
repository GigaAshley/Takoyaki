/**
 * Role and app un-archive through the machine's front door (fleet-change
 * role-unarchive / app-unarchive), answered in the shape the archived lists
 * read. The front door's own behaviour is fleet-change.test.sh's.
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
import { withHost } from "../../sharing/host-conn.js";
import roleRouter from "./role-unarchive.js";

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

describe("POST /roles/:name/unarchive", () => {
  beforeEach(() => serve("/roles", roleRouter));

  it("sends it to the front door and answers restored", async () => {
    const r = await call(server, "POST", "/roles/eng/unarchive", { hostId: 5, requestId: "r1" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, outcome: "restored", requestId: "r1" });
    expect(submitAndFollow).toHaveBeenCalledWith(conn, "role-unarchive", { name: "eng" }, { id: "r1", hostId: 5, totalS: 30 });
  });

  it("passes on a name collision", async () => {
    answer({ state: "refused", code: "name_collision", reason: "a live role named 'eng' already exists on this machine" });
    const r = await call(server, "POST", "/roles/eng/unarchive", { hostId: 5 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "name_collision" });
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "POST", "/roles/eng/unarchive", {})).status).toBe(400);
    expect((await call(server, "POST", "/roles/E_NG/unarchive", { hostId: 5 })).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });
});
