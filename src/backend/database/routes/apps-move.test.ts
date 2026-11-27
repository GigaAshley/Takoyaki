/**
 * Tests for POST /apps/:hostId/:slug/move (project-scoped apps).
 *
 * Bare Express app over node:http; auth, registry, machine people, host
 * access and the host reads/writes are mocked. Who-sees-what decisions are
 * covered by app-move-plan.test.ts — here, the route's wiring: validation,
 * the request sent to the machine's front door, and how its outcomes map.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
          (req as express.Request & { userId: string }).userId = "1";
          next();
        },
    }),
  },
}));
vi.mock("../../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../claude-session/identity-artifact-reader.js", () => ({
  APP_SLUG_RE: /^[a-z0-9-]{1,64}$/,
  PROJECT_SLUG_RE: /^[a-z0-9-]{1,64}$/,
  listProjects: vi.fn(),
}));
vi.mock("../../fleet-change/front-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fleet-change/front-door.js")>()),
  submitFrontDoor: vi.fn(),
}));
vi.mock("../../fleet-status/registry-holder.js", () => ({ getRegistry: vi.fn() }));
vi.mock("../../distributor/machine-people.js", () => ({ listMachinePeople: vi.fn() }));
vi.mock("../../utils/host-user-counter.js", () => ({ getUsernameForUserId: vi.fn() }));
vi.mock("../../sharing/sharing-host.js", () => ({ readShareHostState: vi.fn() }));
vi.mock("../../sharing/host-conn.js", () => {
  class HttpError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { HttpError, withHost: vi.fn() };
});

import { listProjects } from "../../claude-session/identity-artifact-reader.js";
import { submitFrontDoor } from "../../fleet-change/front-door.js";
import { getRegistry } from "../../fleet-status/registry-holder.js";
import { listMachinePeople } from "../../distributor/machine-people.js";
import { getUsernameForUserId } from "../../utils/host-user-counter.js";
import { readShareHostState } from "../../sharing/sharing-host.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import router from "./apps-move.js";

function post(server: http.Server, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : null }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const apps = [
  { hostId: "5", slug: "tally", title: "Tally", owner: "alpha", project: null, users: null },
  { hostId: "5", slug: "beds", title: "Beds", owner: null, project: "garden", users: ["ann"] },
  { hostId: "5", slug: "side", title: "Side", owner: null, project: null, users: null },
];

let server: http.Server;

beforeEach(async () => {
  vi.clearAllMocks();
  (getRegistry as Mock).mockReturnValue({ getAppSnapshot: () => apps });
  (listMachinePeople as Mock).mockResolvedValue([{ username: "ann" }, { username: "bob" }]);
  (getUsernameForUserId as Mock).mockResolvedValue("ann");
  (submitFrontDoor as Mock).mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => ({
    state: "done", id: o.id, seq: 1, result: {},
  }));
  (withHost as Mock).mockImplementation(async (_h: number, _u: string, fn: (c: null) => Promise<unknown>) => fn(null));
  (readShareHostState as Mock).mockResolvedValue({
    people: ["ann", "bob"],
    agents: [{ name: "alpha", label: "Alpha", roles: [], project: null, users: ["ann"] }],
    roles: [],
    projects: [
      { slug: "garden", label: "Garden", parent: null, users: ["ann"] },
      { slug: "shed", label: "Shed", parent: null, users: null },
    ],
    apps: [],
    tasks: [],
  });
  const app = express();
  app.use(express.json());
  app.use("/apps", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
});

afterEach(() => server.close());

describe("POST /apps/:hostId/:slug/move", () => {
  it("sends a sidebar move with the conversation's audience to the front door", async () => {
    const r = await post(server, "/apps/5/tally/move", { to: "sidebar", requestId: "click-1" });
    expect(r.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledWith(null, "app-move", { slug: "tally", to: "sidebar", users: ["ann"] }, { id: "click-1", hostId: 5 });
  });

  it("sends a project move, with a fresh request id when the client gave none", async () => {
    const r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r.status).toBe(200);
    const [, kind, args, opts] = (submitFrontDoor as Mock).mock.calls[0];
    expect(kind).toBe("app-move");
    expect(args).toEqual({ slug: "beds", to: "project", project: "shed" });
    expect(opts.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps the machine's outcomes: refused, failed, still working, still updating", async () => {
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "refused", id: "x", seq: 2, code: "project_archived", reason: '"Shed" is archived' });
    let r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r).toEqual({ status: 409, body: { error: '"Shed" is archived', code: "project_archived", requestId: "x" } });
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "failed", id: "x", seq: 2, code: "move_failed", reason: "no answer on its port" });
    r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r.status).toBe(500);
    expect((r.body as { error: string }).error).toBe("no answer on its port");
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "pending", id: "x", seq: 2, stage: "queued" });
    r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ pending: true, requestId: "x" });
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "not_installed", id: "x" });
    r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r).toEqual({ status: 503, body: { error: "this machine is still updating, try again in a moment", code: "updating" } });
  });

  it("on a single-person machine reads only the projects", async () => {
    (listMachinePeople as Mock).mockResolvedValue([{ username: "ann" }]);
    (listProjects as Mock).mockResolvedValue([{ slug: "shed", displayName: "Shed", parent: null }]);
    const r = await post(server, "/apps/5/side/move", { to: "project", project: "shed" });
    expect(r.status).toBe(200);
    expect(readShareHostState).not.toHaveBeenCalled();
  });

  it("rejects a bad body or slug", async () => {
    expect((await post(server, "/apps/5/side/move", { to: "conversation" })).status).toBe(400);
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "archive" })).status).toBe(400);
    expect((await post(server, "/apps/5/Bad_Slug/move", { to: "sidebar" })).status).toBe(400);
    expect((await post(server, "/apps/0/side/move", { to: "sidebar" })).status).toBe(400);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown app and 503 before the registry exists", async () => {
    expect((await post(server, "/apps/5/nope/move", { to: "sidebar" })).status).toBe(404);
    (getRegistry as Mock).mockReturnValue(null);
    expect((await post(server, "/apps/5/side/move", { to: "sidebar" })).status).toBe(503);
  });

  it("passes refusals through (already there, hidden project) without asking the machine", async () => {
    expect((await post(server, "/apps/5/side/move", { to: "sidebar" })).status).toBe(409);
    (getUsernameForUserId as Mock).mockResolvedValue("bob");
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "garden" })).status).toBe(404);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("maps an unreachable host and a failed request", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "shed" })).status).toBe(504);
    (submitFrontDoor as Mock).mockRejectedValueOnce(new Error("channel closed"));
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "shed" })).status).toBe(500);
  });
});
