/**
 * Tests for POST /apps/:hostId/:slug/move (project-scoped apps).
 *
 * Bare Express app over node:http; auth, registry, machine people, host
 * access and the host reads/writes are mocked. Who-sees-what decisions are
 * covered by app-move-plan.test.ts — here, the route's wiring: validation,
 * the request written into the right folder, and error mapping.
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
vi.mock("../../claude-session/per-app-file.js", () => ({ writeAppFile: vi.fn() }));
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
import { writeAppFile } from "../../claude-session/per-app-file.js";
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
  it("writes a sidebar move with the conversation's audience into the agent's app folder", async () => {
    const r = await post(server, "/apps/5/tally/move", { to: "sidebar" });
    expect(r.status).toBe(202);
    expect(writeAppFile).toHaveBeenCalledWith("tally", ".move-requested", JSON.stringify({ to: "sidebar", users: ["ann"] }), {
      hostId: 5,
      conn: null,
      scope: { owner: "alpha", project: null },
    });
  });

  it("writes a project move into the project app's folder", async () => {
    const r = await post(server, "/apps/5/beds/move", { to: "project", project: "shed" });
    expect(r.status).toBe(202);
    expect(writeAppFile).toHaveBeenCalledWith("beds", ".move-requested", JSON.stringify({ to: "project", project: "shed" }), {
      hostId: 5,
      conn: null,
      scope: { owner: null, project: "garden" },
    });
  });

  it("on a single-person machine reads only the projects", async () => {
    (listMachinePeople as Mock).mockResolvedValue([{ username: "ann" }]);
    (listProjects as Mock).mockResolvedValue([{ slug: "shed", displayName: "Shed", parent: null }]);
    const r = await post(server, "/apps/5/side/move", { to: "project", project: "shed" });
    expect(r.status).toBe(202);
    expect(readShareHostState).not.toHaveBeenCalled();
  });

  it("rejects a bad body or slug", async () => {
    expect((await post(server, "/apps/5/side/move", { to: "conversation" })).status).toBe(400);
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "archive" })).status).toBe(400);
    expect((await post(server, "/apps/5/Bad_Slug/move", { to: "sidebar" })).status).toBe(400);
    expect((await post(server, "/apps/0/side/move", { to: "sidebar" })).status).toBe(400);
    expect(writeAppFile).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown app and 503 before the registry exists", async () => {
    expect((await post(server, "/apps/5/nope/move", { to: "sidebar" })).status).toBe(404);
    (getRegistry as Mock).mockReturnValue(null);
    expect((await post(server, "/apps/5/side/move", { to: "sidebar" })).status).toBe(503);
  });

  it("passes refusals through (already there, hidden project) without writing", async () => {
    expect((await post(server, "/apps/5/side/move", { to: "sidebar" })).status).toBe(409);
    (getUsernameForUserId as Mock).mockResolvedValue("bob");
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "garden" })).status).toBe(404);
    expect(writeAppFile).not.toHaveBeenCalled();
  });

  it("maps an unreachable host and a failed write", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "shed" })).status).toBe(504);
    (writeAppFile as Mock).mockRejectedValueOnce(new Error("disk"));
    expect((await post(server, "/apps/5/side/move", { to: "project", project: "shed" })).status).toBe(500);
  });
});
