/**
 * App archive and un-archive through the machine's front door (fleet-change
 * app-archive / app-unarchive). The front door's own behaviour is
 * fleet-change.test.sh's.
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
import archiveRouter from "./apps-archive.js";
import unarchiveRouter from "./apps-unarchive.js";

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

describe("POST /apps/:hostId/:slug/archive", () => {
  beforeEach(() => serve("/apps", archiveRouter));

  it("sends it to the front door", async () => {
    const r = await call(server, "POST", "/apps/5/tally/archive", { requestId: "a1" });
    expect(r.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "app-archive", { slug: "tally" }, { id: "a1", hostId: 5, by: "1" });
  });

  it("passes a refusal on", async () => {
    answer({ state: "refused", code: "project_app", reason: "a project's apps are archived with the project" });
    const r = await call(server, "POST", "/apps/5/tally/archive", {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "project_app", error: "a project's apps are archived with the project" });
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "POST", "/apps/0/tally/archive", {})).status).toBe(400);
    expect((await call(server, "POST", "/apps/5/Tally/archive", {})).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });
});

describe("POST /apps/:hostId/:slug/unarchive", () => {
  beforeEach(() => serve("/apps", unarchiveRouter));

  it("sends it to the front door and answers restored", async () => {
    const r = await call(server, "POST", "/apps/5/tally/unarchive", { requestId: "u1" });
    expect(r.body).toEqual({ ok: true, outcome: "restored", requestId: "u1" });
    expect(submitAndFollow).toHaveBeenCalledWith(conn, "app-unarchive", { slug: "tally" }, { id: "u1", hostId: 5, totalS: 30, by: "1" });
  });

  it("a port now taken comes back refused, with the machine's reason", async () => {
    answer({ state: "refused", code: "port_in_use", reason: "its port 9200 is now used by another app on this machine" });
    const r = await call(server, "POST", "/apps/5/tally/unarchive", {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: "refused", code: "port_in_use", message: "its port 9200 is now used by another app on this machine" });
  });

  it("back but not started is a failure", async () => {
    answer({ state: "failed", code: "restore_failed", reason: "it's back but couldn't be started: boom" });
    const r = await call(server, "POST", "/apps/5/tally/unarchive", {});
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "restore_failed" });
  });
});
