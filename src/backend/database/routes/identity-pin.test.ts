/**
 * PUT /identities/:key/pinned — pin / unpin one agent, a request to the machine's front
 * door (fleet-change agent-pin). Auth, the machine connection and the front door are mocked;
 * the front door's own behaviour is fleet-change.test.sh's.
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
vi.mock("../../fleet-status/subscription-registry.js", () => ({
  getSubscriptionRegistry: () => ({ publishSessionProjectChanged }),
}));

import { submitFrontDoor } from "../../fleet-change/front-door.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import router from "./identity-pin.js";

function call(server: http.Server, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "PUT", path, headers: { "content-type": "application/json" } },
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
  (withHost as Mock).mockImplementation(async (_h: number, _u: string, fn: (c: unknown) => Promise<unknown>) => fn(conn));
  answer({ state: "done", result: { name: "alpha", pinned: true, previousProject: null } });
  const app = express();
  app.use(express.json());
  app.use("/identities", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
});

afterEach(() => server?.close());

describe("PUT /identities/:key/pinned", () => {
  it("sends the pin to the front door and answers with the pin", async () => {
    const r = await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true, requestId: "click-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pinned: true, requestId: "click-1" });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-pin", { name: "alpha", pinned: true }, { id: "click-1", hostId: 5, by: "1" });
    expect(publishSessionProjectChanged).not.toHaveBeenCalled();
  });

  it("a pin that took it out of its project tells open sidebars", async () => {
    answer({ state: "done", result: { name: "alpha", pinned: true, previousProject: "garden" } });
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true })).status).toBe(200);
    expect(publishSessionProjectChanged).toHaveBeenCalledWith("alpha", 5, null);
  });

  it("unpins", async () => {
    answer({ state: "done", result: { name: "alpha", pinned: false, previousProject: null } });
    const r = await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: false });
    expect(r.body).toMatchObject({ pinned: false });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-pin", { name: "alpha", pinned: false }, expect.anything());
  });

  it("passes the machine's refusal on (being archived)", async () => {
    answer({ state: "refused", code: "being_archived", reason: "it's being archived" });
    const r = await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "being_archived", error: "it's being archived" });
  });

  it("answers 202 while it waits its turn", async () => {
    answer({ state: "pending", stage: "queued" });
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true })).status).toBe(202);
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "/identities/alpha/pinned", { pinned: true })).status).toBe(400);
    expect((await call(server, "/identities/alpha/pinned", { hostId: 0, pinned: true })).status).toBe(400);
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: "yes" })).status).toBe(400);
    expect((await call(server, "/identities/Bad.Key/pinned", { hostId: 5, pinned: true })).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });

  it("maps an unknown host and an unreachable one; refuses no login", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(404, "Host not found"));
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true })).status).toBe(404);
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true })).status).toBe(504);
    mockUserId = null;
    expect((await call(server, "/identities/alpha/pinned", { hostId: 5, pinned: true })).status).toBe(401);
  });
});
