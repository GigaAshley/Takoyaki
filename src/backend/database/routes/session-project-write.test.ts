/**
 * POST /identities/:key/project — Move to / Remove from project, a request to the machine's
 * front door (fleet-change agent-project). Auth, the machine connection and the front door
 * are mocked; the front door's own behaviour is fleet-change.test.sh's.
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
}));
vi.mock("../../sharing/host-conn.js", () => {
  class HttpError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { HttpError, withHost: vi.fn() };
});
const publishSessionProjectChanged = vi.fn();
let registry: { publishSessionProjectChanged: Mock } | null = { publishSessionProjectChanged };
vi.mock("../../fleet-status/subscription-registry.js", () => ({ getSubscriptionRegistry: () => registry }));

import { submitFrontDoor } from "../../fleet-change/front-door.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import router from "./session-project-write.js";

function call(server: http.Server, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } },
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

function answer(outcome: Record<string, unknown>): void {
  (submitFrontDoor as Mock).mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => ({
    id: o.id,
    seq: 1,
    ...outcome,
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockUserId = "1";
  registry = { publishSessionProjectChanged };
  (withHost as Mock).mockImplementation(async (_h: number, _u: string, fn: (c: unknown) => Promise<unknown>) => fn(conn));
  answer({ state: "done", result: { name: "alpha", project: "garden", unpinned: false } });
  const app = express();
  app.use(express.json());
  app.use("/identities", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
});

afterEach(() => server?.close());

describe("POST /identities/:key/project", () => {
  it("sends the move to the front door and tells open sidebars once it's done", async () => {
    const r = await call(server, "/identities/alpha/project", { hostId: 5, project: "garden", requestId: "click-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, requestId: "click-1", result: { project: "garden" } });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-project", { name: "alpha", project: "garden" }, { id: "click-1", hostId: 5 });
    expect(publishSessionProjectChanged).toHaveBeenCalledWith("alpha", 5, "garden");
  });

  it("clears with null", async () => {
    const r = await call(server, "/identities/alpha/project", { hostId: 5, project: null });
    expect(r.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-project", { name: "alpha", project: null }, expect.anything());
    expect(publishSessionProjectChanged).toHaveBeenCalledWith("alpha", 5, null);
  });

  it("passes a refusal on with the machine's reason, and tells nobody", async () => {
    answer({ state: "refused", code: "project_archived", reason: 'the project "Garden" is archived' });
    const r = await call(server, "/identities/alpha/project", { hostId: 5, project: "garden" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "project_archived", error: 'the project "Garden" is archived' });
    expect(publishSessionProjectChanged).not.toHaveBeenCalled();
  });

  it("refuses an agent being archived (the machine's answer)", async () => {
    answer({ state: "refused", code: "being_archived", reason: "it's being archived" });
    const r = await call(server, "/identities/alpha/project", { hostId: 5, project: "garden" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "being_archived" });
  });

  it("answers 202 while it waits its turn, 503 while the machine updates", async () => {
    answer({ state: "pending", stage: "queued" });
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: "garden" })).status).toBe(202);
    (submitFrontDoor as Mock).mockResolvedValue({ state: "not_installed", id: "x" });
    const r = await call(server, "/identities/alpha/project", { hostId: 5, project: "garden" });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "updating" });
    expect(publishSessionProjectChanged).not.toHaveBeenCalled();
  });

  it("a publish failure doesn't turn a done move into an error", async () => {
    publishSessionProjectChanged.mockImplementationOnce(() => {
      throw new Error("ws down");
    });
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: "garden" })).status).toBe(200);
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "/identities/alpha/project", { project: "garden" })).status).toBe(400);
    expect((await call(server, "/identities/alpha/project", { hostId: "x", project: "garden" })).status).toBe(400);
    expect((await call(server, "/identities/Bad.Key/project", { hostId: 5, project: "garden" })).status).toBe(400);
    expect((await call(server, "/identities/alpha/project", { hostId: 5 })).status).toBe(400);
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: "Garden" })).status).toBe(400);
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: "" })).status).toBe(400);
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: 3 })).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });

  it("maps an unknown host and an unreachable one; refuses no login", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(404, "Host not found"));
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: null })).status).toBe(404);
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: null })).status).toBe(504);
    mockUserId = null;
    expect((await call(server, "/identities/alpha/project", { hostId: 5, project: null })).status).toBe(401);
  });
});
