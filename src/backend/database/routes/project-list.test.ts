/**
 * Phase 117 Plan 117-04: Tests for the /projects route.
 *
 * Tests exercise:
 *   GET  /projects?hostId=<n>
 *   POST /projects
 *   POST /projects/:slug/archive
 *
 * All routes gate on authenticateJWT + resolveHostById(hostId, userId) with
 * 404-on-cross-user (probe-distinguisher defense). Every route uses a JSON
 * body per D-36a. Every successful write path calls
 * subscriptionRegistry.publishProjectListChanged(<currentProjectsArray>).
 *
 * Auth middleware is mocked. resolveHostById, connectOneShot, isLocalHostId,
 * listProjects and the machine's front door are mocked so tests exercise
 * every branch without touching real disk or SSH.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Auth manager mock
// ---------------------------------------------------------------------------

let mockUserId: string | null = "1";

vi.mock("../../utils/auth-manager.js", () => {
  const AuthManager = {
    getInstance: () => ({
      createAuthMiddleware: () =>
        (
          req: express.Request,
          res: express.Response,
          next: express.NextFunction,
        ) => {
          if (mockUserId === null) {
            return res.status(401).json({ error: "Unauthorized" });
          }
          (req as express.Request & { userId: string }).userId = mockUserId;
          next();
        },
    }),
  };
  return { AuthManager };
});

// Mute logger during tests.
vi.mock("../../utils/logger.js", () => ({
  databaseLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// SSH + artifact-reader mocks
// ---------------------------------------------------------------------------

vi.mock("../../ssh/ssh-one-shot.js", () => ({
  connectOneShot: vi.fn(),
}));

vi.mock("../../ssh/host-resolver.js", () => ({
  resolveHostById: vi.fn(),
}));

vi.mock("../../claude-session/identity-artifact-reader.js", () => ({
  isLocalHostId: vi.fn(),
  PROJECT_SLUG_RE: /^[a-z0-9-]{1,64}$/,
  listProjects: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  // Minimal stand-in for the real parser: only the parent line matters to
  // the routes (PUT /file's parent guard).
  projectMetaFromMarkdown: (slug: string, markdown: string) => {
    const m = /^parent:\s*([a-z0-9-]+)\s*$/m.exec(markdown);
    return {
      slug,
      displayName: slug,
      users: null,
      parent: m && m[1] !== slug ? m[1] : null,
    };
  },
}));

// The machine's front door (fleet-change) and the relay-room lookups.
vi.mock("../../fleet-change/front-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fleet-change/front-door.js")>()),
  submitFrontDoor: vi.fn(),
  frontDoorStatus: vi.fn(),
}));
vi.mock("../../fleet-change/project-rooms.js", () => ({
  findProjectRooms: vi.fn(),
  releaseProjectRooms: vi.fn(),
}));

// Phase 130: host-user-counter mock — auto-tag path in POST /projects consults
// isHostMultiUser + getUsernameForUserId. Default is single-user + no
// username, so auto-tag stays quiet across every pre-130 test unless a
// specific test overrides.
vi.mock("../../utils/host-user-counter.js", () => ({
  isHostMultiUser: vi.fn().mockResolvedValue(false),
  getUsernameForUserId: vi.fn().mockResolvedValue(null),
}));

// subscription-registry singleton accessor — Wave 2 route relies on this
// to reach the WS registry that starter.ts creates. See getSubscriptionRegistry
// export added in Phase 117 Plan 04.
//
// Phase 117 M8 fix (2026-09-18): the mock now consults a mutable flag so
// specific tests can simulate the null-registry path (a startup-timing
// bug in production; a common state during initial test setup).
const mockPublishProjectListChanged = vi.fn();
let mockRegistryIsNull = false;
vi.mock("../../fleet-status/subscription-registry.js", () => ({
  getSubscriptionRegistry: () =>
    mockRegistryIsNull
      ? null
      : {
          publishProjectListChanged: mockPublishProjectListChanged,
        },
}));

// ---------------------------------------------------------------------------
// Import mocked modules AFTER vi.mock() declarations
// ---------------------------------------------------------------------------

import { frontDoorStatus, submitFrontDoor } from "../../fleet-change/front-door.js";
import { findProjectRooms, releaseProjectRooms } from "../../fleet-change/project-rooms.js";
import { connectOneShot } from "../../ssh/ssh-one-shot.js";
import { resolveHostById } from "../../ssh/host-resolver.js";
import {
  isLocalHostId,
  listProjects,
  readProjectFile,
  writeProjectFile,
} from "../../claude-session/identity-artifact-reader.js";
// Phase 117 M8 fix (2026-09-18): import the mocked databaseLogger so
// null-registry tests can assert the warning is logged.
import { databaseLogger } from "../../utils/logger.js";
import {
  __resetHostSemaphoreRegistryForTests,
  getHostSemaphore,
} from "../../ssh/host-semaphore-registry.js";
// Phase 130: auto-tag path helpers.
import {
  isHostMultiUser,
  getUsernameForUserId,
} from "../../utils/host-user-counter.js";

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

function httpRequest(
  server: http.Server,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    sendAuthHeader?: boolean;
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const bodyStr =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
    };
    if (bodyStr !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubConn = {
  end: vi.fn(),
  exec: vi.fn(),
};

const stubHost = {
  id: 5,
  name: "myhost",
  ip: "10.0.0.5",
  port: 22,
  username: "ubuntu",
  authType: "password" as const,
  password: "secret",
};

// ---------------------------------------------------------------------------
// Import the router under test AFTER all vi.mock() calls
// ---------------------------------------------------------------------------

import router from "./project-list.js";

let server: http.Server;

beforeEach(() => {
  vi.clearAllMocks();
  // Phase 117 M8 fix (2026-09-18): reset the null-registry flag between
  // tests so a null-registry test doesn't leak into subsequent tests.
  mockRegistryIsNull = false;

  // Default: user owns host 5 (local) and host 7 (remote); host 99 not owned.
  (resolveHostById as Mock).mockImplementation((hostId: number) => {
    if (hostId === 5 || hostId === 7)
      return Promise.resolve({ ...stubHost, id: hostId });
    return Promise.resolve(null);
  });

  // Default: hostId 5 is local, hostId 7 is remote.
  (isLocalHostId as Mock).mockImplementation((hostId: number) => hostId === 5);

  // Default: SSH connect resolves to stubConn.
  (connectOneShot as Mock).mockResolvedValue(stubConn);

  // Default: primitives resolve to sensible defaults; per-test overrides.
  (listProjects as Mock).mockResolvedValue([]);
  (submitFrontDoor as Mock).mockImplementation(async (_c: unknown, kind: string, args: { slug: string }, o: { id?: string }) =>
    kind === "project-archive"
      ? { state: "done", id: o.id ?? "r1", seq: 1, result: { projects: [{ slug: args.slug, archivedAs: args.slug }], agents: [], apps: [] } }
      : { state: "done", id: o.id ?? "r1", seq: 1, result: { project: args.slug, projects: [{ slug: args.slug, displayName: args.slug, parent: null }], agents: [], apps: [] } },
  );
  (frontDoorStatus as Mock).mockResolvedValue(null);
  (findProjectRooms as Mock).mockResolvedValue([]);
  (releaseProjectRooms as Mock).mockResolvedValue([]);
  (readProjectFile as Mock).mockResolvedValue({ markdown: "" });
  (writeProjectFile as Mock).mockResolvedValue({ markdown: "" });
  // Phase 130: reset auto-tag helpers each test — vi.clearAllMocks() clears
  // call history but preserves implementation, so a prior test's override
  // would leak into a later test's assertions.
  (isHostMultiUser as Mock).mockResolvedValue(false);
  (getUsernameForUserId as Mock).mockResolvedValue(null);

  // Rebuild app per test.
  const app = express();
  app.use(express.json());
  app.use("/projects", router);

  server = http.createServer(app);
  server.listen(0);
});

afterEach(() => {
  mockUserId = "1";
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

// ===========================================================================
// GET /projects
// ===========================================================================

describe("GET /projects", () => {
  it("Test 1: happy LOCAL → 200 with archived:false enriched projects; no SSH", async () => {
    (listProjects as Mock).mockResolvedValue([
      { slug: "a", displayName: "Alpha" },
    ]);

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [{ slug: "a", displayName: "Alpha", archived: false }],
    });
    expect(connectOneShot).not.toHaveBeenCalled();
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith(null);
  });

  it("Test 2: happy REMOTE → 200 with SSH conn passed; conn.end() in finally", async () => {
    (listProjects as Mock).mockResolvedValue([
      { slug: "a", displayName: "Alpha" },
      { slug: "b", displayName: "Beta" },
    ]);

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=7",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [
        { slug: "a", displayName: "Alpha", archived: false },
        { slug: "b", displayName: "Beta", archived: false },
      ],
    });
    expect(connectOneShot).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith(stubConn);
    expect(stubConn.end).toHaveBeenCalledTimes(1);
  });

  it("Test 3: missing hostId → 400", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects",
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/hostId is required/);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("Test 4: bad hostId → 400", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=abc",
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/hostId/);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("Test 5: unknown/cross-user hostId → 404 (NOT 403 — probe defense)", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=99",
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/Host not found/);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("Test 6: REMOTE unreachable (connectOneShot throws) → 504", async () => {
    (connectOneShot as Mock).mockRejectedValue(
      new Error("Connect timeout after 3000ms"),
    );

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=7",
    });

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: "Host unreachable" });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("Test 7: unauth (no JWT) → 401; listProjects not called", async () => {
    mockUserId = null;

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });

    expect(res.status).toBe(401);
    expect(listProjects).not.toHaveBeenCalled();
    expect(resolveHostById).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Phase 130: per-user READ-side gate on GET /projects
  // ---------------------------------------------------------------------------
  it("Test 7a (Phase 130): projects with users → filtered to caller's visible set; response strips users field", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "alpha", displayName: "Alpha", users: ["alice"] }, // visible
      { slug: "beta", displayName: "Beta", users: ["riley"] }, // hidden
      { slug: "gamma", displayName: "Gamma", users: null }, // falls open
      { slug: "delta", displayName: "Delta", users: [] }, // falls open (empty)
    ]);

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [
        { slug: "alpha", displayName: "Alpha", archived: false },
        { slug: "gamma", displayName: "Gamma", archived: false },
        { slug: "delta", displayName: "Delta", archived: false },
      ],
    });
    // Response body MUST NOT leak the users field (Phase 129 HIGH-1 mirror).
    const projects = (res.body as { projects: Array<Record<string, unknown>> })
      .projects;
    for (const p of projects) {
      expect(p).not.toHaveProperty("users");
    }
  });

  it("Test 7b (Phase 130): username lookup returns null → gate disabled, all projects visible (fail-open)", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue(null);
    (listProjects as Mock).mockResolvedValue([
      { slug: "alpha", displayName: "Alpha", users: ["alice"] },
      { slug: "beta", displayName: "Beta", users: ["riley"] },
    ]);

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });

    expect(res.status).toBe(200);
    // Null caller = gate disabled = every project falls through.
    expect(res.body).toEqual({
      projects: [
        { slug: "alpha", displayName: "Alpha", archived: false },
        { slug: "beta", displayName: "Beta", archived: false },
      ],
    });
  });

  it("Test 7c (Phase 130): username lookup throws → gate disabled + warn logged (fail-open)", async () => {
    (getUsernameForUserId as Mock).mockRejectedValue(
      new Error("db unreachable"),
    );
    (listProjects as Mock).mockResolvedValue([
      { slug: "alpha", displayName: "Alpha", users: ["alice"] },
      { slug: "beta", displayName: "Beta", users: ["riley"] },
    ]);

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });

    expect(res.status).toBe(200);
    // Fail-open: BOTH visible even though caller shouldn't match either.
    expect((res.body as { projects: unknown[] }).projects).toHaveLength(2);
    expect(databaseLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /caller username lookup threw.*gate disabled.*db unreachable/,
      ),
    );
  });
});

// ===========================================================================
// POST /projects, POST /projects/:slug/parent, POST /projects/:slug/rename —
// requests to the machine's front door (project-create / project-move /
// project-rename). What the machine does with them (free slugs, visibility,
// loops, the never-widen rule) is fleet-change.test.sh's; here: what the route
// sends, how it answers, and that open tabs hear once it's done.
// ===========================================================================

function sent(kind: string): Record<string, unknown> | undefined {
  const call = (submitFrontDoor as Mock).mock.calls.find((c) => c[1] === kind);
  return call?.[2] as Record<string, unknown> | undefined;
}

function machineAnswers(outcome: Record<string, unknown>): void {
  (submitFrontDoor as Mock).mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id?: string }) => ({
    id: o.id ?? "r1",
    seq: 1,
    ...outcome,
  }));
}

describe("POST /projects (front door)", () => {
  it("sends the derived base slug, the name, who's asking and whether the machine is shared", async () => {
    (isHostMultiUser as Mock).mockResolvedValue(true);
    (getUsernameForUserId as Mock).mockResolvedValue("riley");
    machineAnswers({ state: "done", result: { slug: "ops-two-2", displayName: "Ops 2", parent: null, users: ["riley"] } });
    (listProjects as Mock).mockResolvedValue([{ slug: "ops-two-2", displayName: "Ops 2", users: ["riley"], parent: null }]);
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects",
      body: { hostId: 5, displayName: "  Ops 2  ", requestId: "click-1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, requestId: "click-1", result: { slug: "ops-two-2" } });
    expect(submitFrontDoor).toHaveBeenCalledWith(
      null,
      "project-create",
      { baseSlug: "ops-two", displayName: "Ops 2", parent: null, asker: "riley", multiUser: true },
      { id: "click-1", hostId: 5 },
    );
    expect(mockPublishProjectListChanged).toHaveBeenCalledTimes(1);
    expect(mockPublishProjectListChanged.mock.calls[0]?.[0]).toBe("5");
  });

  it("passes a parent; a refusal comes back with the machine's reason and nothing is published", async () => {
    machineAnswers({ state: "refused", code: "parent_not_found", reason: "parent project not found" });
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects",
      body: { hostId: 5, displayName: "Kid", parent: "secret" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "parent_not_found", error: "parent project not found" });
    expect(sent("project-create")).toMatchObject({ parent: "secret" });
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
  });

  it("falls open when the shared-machine check or the username lookup fails", async () => {
    (isHostMultiUser as Mock).mockRejectedValue(new Error("db"));
    (getUsernameForUserId as Mock).mockRejectedValue(new Error("db"));
    const res = await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "X" } });
    expect(res.status).toBe(200);
    expect(sent("project-create")).toMatchObject({ asker: null, multiUser: false });
  });

  it("a long name's base slug is cut to what the machine takes (room for -2, -3, …)", async () => {
    await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "Plan 7777777 for the big launch" } });
    const base = sent("project-create")?.baseSlug as string;
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base).toMatch(/^[a-z-]*[a-z]$/);
  });

  it("a remote machine is asked over its SSH connection", async () => {
    const res = await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 7, displayName: "X" } });
    expect(res.status).toBe(200);
    expect((submitFrontDoor as Mock).mock.calls[0]?.[0]).toBe(stubConn);
    expect(stubConn.end).toHaveBeenCalled();
  });

  it("still waiting → 202; machine updating → 503", async () => {
    machineAnswers({ state: "pending", stage: "queued" });
    expect((await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "X" } })).status).toBe(202);
    (submitFrontDoor as Mock).mockResolvedValue({ state: "not_installed", id: "x" });
    const r = await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "X" } });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "updating" });
  });

  it("a missing registry is logged, not an error", async () => {
    mockRegistryIsNull = true;
    const res = await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "X" } });
    expect(res.status).toBe(200);
    expect(databaseLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/registry not initialized/));
  });

  it("validates before asking the machine", async () => {
    const bad = [
      { displayName: "X" },
      { hostId: 5 },
      { hostId: 5, displayName: "   " },
      { hostId: 5, displayName: "!!!" },
      { hostId: 5, displayName: "two\nlines" },
      { hostId: 5, displayName: "x".repeat(81) },
      { hostId: 5, displayName: "X", parent: "Bad Slug" },
    ];
    for (const body of bad) {
      expect((await httpRequest(server, { method: "POST", path: "/projects", body })).status).toBe(400);
    }
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("an unknown host → 404; SSH off → 400", async () => {
    expect((await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 99, displayName: "X" } })).status).toBe(404);
    (resolveHostById as Mock).mockResolvedValue({ ...stubHost, enableSsh: false });
    expect((await httpRequest(server, { method: "POST", path: "/projects", body: { hostId: 5, displayName: "X" } })).status).toBe(400);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });
});

describe("POST /projects/:slug/parent (front door)", () => {
  it("sends the move with who's asking, publishes once done", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("riley");
    machineAnswers({ state: "done", result: { slug: "c", parent: "q", audienceKept: null } });
    const res = await httpRequest(server, { method: "POST", path: "/projects/c/parent", body: { hostId: 5, parent: "q" } });
    expect(res.status).toBe(200);
    expect(sent("project-move")).toEqual({ slug: "c", parent: "q", asker: "riley" });
    expect(mockPublishProjectListChanged).toHaveBeenCalledTimes(1);
  });

  it("null moves it to top level", async () => {
    await httpRequest(server, { method: "POST", path: "/projects/c/parent", body: { hostId: 5, parent: null } });
    expect(sent("project-move")).toMatchObject({ slug: "c", parent: null });
  });

  it("the machine's refusal (into itself, gone, hidden) comes back as 409 with its reason", async () => {
    machineAnswers({ state: "refused", code: "into_itself", reason: "cannot move a project inside itself or its own sub-project" });
    const res = await httpRequest(server, { method: "POST", path: "/projects/a/parent", body: { hostId: 5, parent: "b" } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "into_itself" });
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
  });

  it("validates before asking the machine", async () => {
    expect((await httpRequest(server, { method: "POST", path: "/projects/Bad/parent", body: { hostId: 5, parent: null } })).status).toBe(400);
    expect((await httpRequest(server, { method: "POST", path: "/projects/c/parent", body: { hostId: 5, parent: "Bad Slug" } })).status).toBe(400);
    expect((await httpRequest(server, { method: "POST", path: "/projects/c/parent", body: { parent: null } })).status).toBe(400);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });
});

describe("POST /projects/:slug/rename (front door)", () => {
  it("sends only the new name", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("riley");
    machineAnswers({ state: "done", result: { slug: "team", displayName: "Dream Team" } });
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/team/rename",
      body: { hostId: 5, displayName: " Dream Team ", requestId: "r-9" },
    });
    expect(res.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledWith(
      null,
      "project-rename",
      { slug: "team", displayName: "Dream Team", asker: "riley" },
      { id: "r-9", hostId: 5 },
    );
    expect(mockPublishProjectListChanged).toHaveBeenCalledTimes(1);
  });

  it("a project gone or hidden by its turn is the machine's 409", async () => {
    machineAnswers({ state: "refused", code: "not_found", reason: "Project not found" });
    expect((await httpRequest(server, { method: "POST", path: "/projects/team/rename", body: { hostId: 5, displayName: "X" } })).status).toBe(409);
  });

  it("validates before asking the machine", async () => {
    for (const displayName of ["", "  ", "x".repeat(81), "two\nlines", 3]) {
      expect(
        (await httpRequest(server, { method: "POST", path: "/projects/team/rename", body: { hostId: 5, displayName } })).status,
      ).toBe(400);
    }
    expect((await httpRequest(server, { method: "POST", path: "/projects/Bad/rename", body: { hostId: 5, displayName: "X" } })).status).toBe(400);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /projects/:slug/archive
// ===========================================================================

const EXPECTED = { projects: ["my-project"], agents: [], apps: [] };

describe("POST /projects/:slug/archive", () => {
  it("Test 13: happy → 200; the front door archives with the confirmed list; rooms released; list published", async () => {
    (listProjects as Mock).mockResolvedValueOnce([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    (listProjects as Mock).mockResolvedValue([]);
    (releaseProjectRooms as Mock).mockResolvedValue([{ roomId: "!r:x", project: "my-project" }]);

    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED, requestId: "click-9" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      requestId: "click-9",
      result: {
        projects: [{ slug: "my-project", archivedAs: "my-project" }],
        agents: [],
        apps: [],
        rooms: [{ roomId: "!r:x", project: "my-project" }],
      },
    });
    expect(submitFrontDoor).toHaveBeenCalledWith(
      null,
      "project-archive",
      { slug: "my-project", expected: EXPECTED },
      { id: "click-9", hostId: 5 },
    );
    expect(releaseProjectRooms).toHaveBeenCalledWith("1", ["my-project"]);
    expect(mockPublishProjectListChanged).toHaveBeenCalledTimes(1);
    const call = mockPublishProjectListChanged.mock.calls[0];
    expect(call[0]).toBe("5");
    expect(call[1]).toEqual([]);
  });

  // Phase 117 M8 fix (2026-09-18): null-registry on archive path also logs.
  it("Test 13b (M8 fix): null registry on archive → publish silently skipped BUT a warning is logged", async () => {
    mockRegistryIsNull = true;
    (listProjects as Mock).mockResolvedValue([{ slug: "my-project", displayName: "My", users: null, parent: null }]);

    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED },
    });

    expect(res.status).toBe(200);
    expect(submitFrontDoor).toHaveBeenCalledTimes(1);
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
    expect(databaseLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /subscription registry not initialized.*hostId=5.*slug=my-project.*op=archive/,
      ),
    );
  });

  it("Test 13c: the machine's contents changed → 409 contents_changed with the current list; nothing released", async () => {
    (listProjects as Mock).mockResolvedValue([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    const current = { project: "my-project", projects: [{ slug: "my-project", displayName: "My", parent: null }], agents: [{ name: "finch", displayName: "finch", task: "", project: "my-project" }], apps: [] };
    (submitFrontDoor as Mock).mockResolvedValueOnce({
      state: "refused", id: "r2", seq: 3, code: "contents_changed", reason: "what's in \"My\" changed since you looked; check the list again", result: current,
    });
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "contents_changed", result: current });
    expect(releaseProjectRooms).not.toHaveBeenCalled();
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
  });

  it("Test 13d: still working → 202; machine still updating → 503", async () => {
    (listProjects as Mock).mockResolvedValue([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "pending", id: "r3", seq: 4, stage: "running" });
    let res = await httpRequest(server, { method: "POST", path: "/projects/my-project/archive", body: { hostId: 5, expected: EXPECTED } });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pending: true, requestId: "r3" });
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "not_installed", id: "r4" });
    res = await httpRequest(server, { method: "POST", path: "/projects/my-project/archive", body: { hostId: 5, expected: EXPECTED } });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "updating" });
  });

  it("Test 13f: the same request again after the project is gone → its outcome, rooms released", async () => {
    (listProjects as Mock).mockResolvedValue([]);
    (frontDoorStatus as Mock).mockResolvedValueOnce({ state: "done", id: "click-9", seq: 5, result: {} });
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED, requestId: "click-9" },
    });
    expect(res.status).toBe(200);
    expect(frontDoorStatus).toHaveBeenCalledWith(null, "click-9", 0);
    expect(submitFrontDoor).toHaveBeenCalledWith(null, "project-archive", { slug: "my-project", expected: EXPECTED }, { id: "click-9", hostId: 5 });
    expect(releaseProjectRooms).toHaveBeenCalledWith("1", ["my-project"]);
  });

  it("Test 13g: still working → the server keeps asking and does its part (rooms, other tabs) once it's done", async () => {
    (listProjects as Mock).mockResolvedValue([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "pending", id: "slow-1", seq: 6, stage: "running" });
    (frontDoorStatus as Mock)
      .mockResolvedValueOnce(null) // the route's "already sent?" check
      .mockResolvedValueOnce({ state: "pending", id: "slow-1", seq: 6, stage: "running" })
      .mockResolvedValueOnce({ state: "done", id: "slow-1", seq: 6, result: { projects: [{ slug: "my-project", archivedAs: "my-project" }], agents: [], apps: [] } });
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED, requestId: "slow-1" },
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(releaseProjectRooms).toHaveBeenCalledWith("1", ["my-project"]));
    expect(mockPublishProjectListChanged).toHaveBeenCalled();
  });

  it("Test 13h: contents changed to include a sub-project hidden from the caller → refused without showing it", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "my-project", displayName: "My", users: null, parent: null },
      { slug: "secret", displayName: "Secret", users: ["bob"], parent: "my-project" },
    ]);
    // Visible at the route's check (secret appears only on the machine's turn): simulate by
    // letting the first listing omit it.
    (listProjects as Mock).mockResolvedValueOnce([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    (submitFrontDoor as Mock).mockResolvedValueOnce({
      state: "refused", id: "r5", seq: 7, code: "contents_changed", reason: "changed",
      result: { project: "my-project", projects: [{ slug: "my-project", displayName: "My", parent: null }, { slug: "secret", displayName: "Secret", parent: "my-project" }], agents: [], apps: [] },
    });
    const res = await httpRequest(server, { method: "POST", path: "/projects/my-project/archive", body: { hostId: 5, expected: EXPECTED } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "some sub-projects inside it are hidden from you", code: "sub_projects_hidden" });
  });

  it("Test 13e: missing or malformed expected list → 400 before any I/O", async () => {
    for (const expected of [undefined, { projects: ["a"] }, { projects: "a", agents: [], apps: [] }]) {
      const res = await httpRequest(server, { method: "POST", path: "/projects/my-project/archive", body: { hostId: 5, expected } });
      expect(res.status).toBe(400);
    }
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("Test 14: bad slug (uppercase / metacharacters) → 400 (PROJECT_SLUG_RE gate)", async () => {
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/BAD!/archive",
      body: { hostId: 5, expected: EXPECTED },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/slug/);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("Test 15: unknown host → 404", async () => {
    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 99, expected: EXPECTED },
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/Host not found/);
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("Test 16: the front door can't be reached → 500 generic (no err.message leak)", async () => {
    (listProjects as Mock).mockResolvedValue([{ slug: "my-project", displayName: "My", users: null, parent: null }]);
    (submitFrontDoor as Mock).mockRejectedValue(
      new Error(
        "EACCES: /private/fs/path leaked — sensitive info to caller",
      ),
    );

    const res = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED },
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "failed to archive project" });
    // T-117-04-05 — underlying err.message must NOT reach the client.
    expect(JSON.stringify(res.body)).not.toContain("EACCES");
    expect(JSON.stringify(res.body)).not.toContain("sensitive info");
    // Failure → no wire event.
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GET /projects/:slug/file
// ===========================================================================

describe("GET /projects/:slug/file", () => {
  it("Test F1: happy LOCAL → 200 { markdown } from readProjectFile(null, slug); no SSH", async () => {
    (readProjectFile as Mock).mockResolvedValue({
      markdown: "---\ndisplayName: 'Alpha'\n---\nbody",
    });

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/alpha/file?hostId=5",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      markdown: "---\ndisplayName: 'Alpha'\n---\nbody",
    });
    expect(connectOneShot).not.toHaveBeenCalled();
    expect(readProjectFile).toHaveBeenCalledTimes(1);
    expect(readProjectFile).toHaveBeenCalledWith(null, "alpha");
  });

  it("Test F2: happy REMOTE → 200 with SSH conn passed; conn.end() in finally", async () => {
    (readProjectFile as Mock).mockResolvedValue({ markdown: "body" });

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/alpha/file?hostId=7",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markdown: "body" });
    expect(connectOneShot).toHaveBeenCalledTimes(1);
    expect(readProjectFile).toHaveBeenCalledWith(stubConn, "alpha");
    expect(stubConn.end).toHaveBeenCalled();
  });

  it("Test F3: invalid slug — 'Alpha' → 400 before any I/O", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/Alpha/file?hostId=5",
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/slug/);
    expect(readProjectFile).not.toHaveBeenCalled();
  });

  it("Test F4: missing hostId → 400 before any I/O", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/alpha/file",
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/hostId/);
    expect(readProjectFile).not.toHaveBeenCalled();
  });

  it("Test F5: unknown host → 404 (cross-user probe defense T-117-04-01)", async () => {
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/alpha/file?hostId=99",
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/Host not found/);
    expect(readProjectFile).not.toHaveBeenCalled();
  });

  it("Test F6: readProjectFile throws → 500 generic (no err.message leak)", async () => {
    (readProjectFile as Mock).mockRejectedValue(
      new Error("EACCES: /private/fs/path leaked — sensitive info to caller"),
    );

    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/alpha/file?hostId=5",
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "failed to read project file" });
    expect(JSON.stringify(res.body)).not.toContain("EACCES");
    expect(JSON.stringify(res.body)).not.toContain("sensitive info");
  });
});

// ===========================================================================
// PUT /projects/:slug/file
// ===========================================================================

describe("PUT /projects/:slug/file", () => {
  it("Test G1: happy LOCAL → 200 { markdown } from writeProjectFile(null, slug, contents)", async () => {
    (writeProjectFile as Mock).mockResolvedValue({ markdown: "new body" });

    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5, contents: "new body" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markdown: "new body" });
    expect(connectOneShot).not.toHaveBeenCalled();
    expect(writeProjectFile).toHaveBeenCalledTimes(1);
    expect(writeProjectFile).toHaveBeenCalledWith(null, "alpha", "new body");
  });

  it("Test G2: happy REMOTE → 200 with SSH conn passed; conn.end() in finally", async () => {
    (writeProjectFile as Mock).mockResolvedValue({ markdown: "body" });

    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 7, contents: "body" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markdown: "body" });
    expect(connectOneShot).toHaveBeenCalledTimes(1);
    expect(writeProjectFile).toHaveBeenCalledWith(stubConn, "alpha", "body");
    expect(stubConn.end).toHaveBeenCalled();
  });

  it("Test G3: invalid slug — 'Alpha' → 400 before any I/O", async () => {
    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/Alpha/file",
      body: { hostId: 5, contents: "body" },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/slug/);
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("Test G4: missing contents → 400 before any I/O", async () => {
    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5 },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/contents/);
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("Test G5: non-string contents → 400 before any I/O", async () => {
    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5, contents: 123 },
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/contents/);
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("Test G6: unknown host → 404", async () => {
    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 99, contents: "body" },
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/Host not found/);
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("Test G8: happy write → publishProjectListChanged fires with re-listed enriched projects (project.md displayName edits repaint the sidebar)", async () => {
    (writeProjectFile as Mock).mockResolvedValue({ markdown: "" });
    (listProjects as Mock).mockResolvedValue([
      { slug: "alpha", displayName: "New Name", users: null },
    ]);

    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5, contents: "---\ndisplayName: New Name\n---\n" },
    });

    expect(res.status).toBe(200);
    expect(mockPublishProjectListChanged).toHaveBeenCalledTimes(1);
    const call = mockPublishProjectListChanged.mock.calls[0];
    expect(call[0]).toBe("5");
    expect(call[1]).toEqual([
      {
        slug: "alpha",
        displayName: "New Name",
        hostId: "5",
        hostname: "myhost",
        archived: false,
        users: null,
      },
    ]);
  });

  it("Test G9 (null registry on write-file): publish skipped BUT a warning is logged (mirror M8 fix)", async () => {
    mockRegistryIsNull = true;
    (writeProjectFile as Mock).mockResolvedValue({ markdown: "" });

    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5, contents: "body" },
    });

    expect(res.status).toBe(200);
    expect(mockPublishProjectListChanged).not.toHaveBeenCalled();
    expect(databaseLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /subscription registry not initialized.*hostId=5.*slug=alpha.*op=write-file/,
      ),
    );
  });

  it("Test G10: writeProjectFile throws → 500 generic (no err.message leak)", async () => {
    (writeProjectFile as Mock).mockRejectedValue(
      new Error("ENOENT: /host/private/path leaked — sensitive info"),
    );

    const res = await httpRequest(server, {
      method: "PUT",
      path: "/projects/alpha/file",
      body: { hostId: 5, contents: "body" },
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "failed to write project file" });
    expect(JSON.stringify(res.body)).not.toContain("ENOENT");
    expect(JSON.stringify(res.body)).not.toContain("sensitive info");
  });
});

// ===========================================================================
// Nested projects
// ===========================================================================

describe("nested projects — GET /projects parent + inherited visibility", () => {
  it("carries parent on every entry", async () => {
    (listProjects as Mock).mockResolvedValue([
      { slug: "top", displayName: "Top", users: null, parent: null },
      { slug: "kid", displayName: "Kid", users: null, parent: "top" },
    ]);
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [
        { slug: "top", displayName: "Top", archived: false, parent: null },
        { slug: "kid", displayName: "Kid", archived: false, parent: "top" },
      ],
    });
  });

  it("a parent hidden from the caller hides its child and grandchild; a missing parent does not hide", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "secret", displayName: "Secret", users: ["riley"], parent: null },
      { slug: "kid", displayName: "Kid", users: null, parent: "secret" },
      { slug: "grandkid", displayName: "GK", users: ["alice"], parent: "kid" },
      { slug: "orphan", displayName: "Orphan", users: null, parent: "gone" },
    ]);
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [
        { slug: "orphan", displayName: "Orphan", archived: false, parent: "gone" },
      ],
    });
  });
});

describe("nested projects — review fixes", () => {
  it("archive refuses while a sub-project inside is hidden; a loop partner doesn't count", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "p", displayName: "P", users: null, parent: null },
      { slug: "hidden", displayName: "H", users: ["bob"], parent: "p" },
    ]);
    const refused = await httpRequest(server, {
      method: "POST",
      path: "/projects/p/archive",
      body: { hostId: 5, expected: { projects: ["p"], agents: [], apps: [] } },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "sub_projects_hidden" });
    expect(submitFrontDoor).not.toHaveBeenCalled();

    (listProjects as Mock).mockResolvedValue([
      { slug: "a", displayName: "A", users: null, parent: "b" },
      { slug: "b", displayName: "B", users: null, parent: "a" },
    ]);
    const loop = await httpRequest(server, {
      method: "POST",
      path: "/projects/a/archive",
      body: { hostId: 5, expected: { projects: ["a"], agents: [], apps: [] } },
    });
    expect(loop.status).toBe(200);
    expect((submitFrontDoor as Mock).mock.calls[0]?.[2]).toMatchObject({ slug: "a" });
  });

  it("archive preflight: the machine's contents and the caller's rooms; a project hidden from the caller is not found", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "p", displayName: "P", users: ["alice", "bob"], parent: null },
      { slug: "seen", displayName: "S", users: null, parent: "p" },
      { slug: "other", displayName: "O", users: ["bob"], parent: null },
    ]);
    const contents = {
      project: "p",
      projects: [{ slug: "p", displayName: "P", parent: null }, { slug: "seen", displayName: "S", parent: "p" }],
      agents: [],
      apps: [{ slug: "tally", title: "Tally", project: "seen" }],
    };
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "done", id: "c1", seq: 7, result: contents });
    (findProjectRooms as Mock).mockResolvedValueOnce([{ roomId: "!r:x", project: "seen" }]);
    const res = await httpRequest(server, {
      method: "GET",
      path: "/projects/p/archive-preflight?hostId=5",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hiddenSubProjects: 0, contents, rooms: [{ roomId: "!r:x", project: "seen" }], roomsUnknown: false });
    expect((submitFrontDoor as Mock).mock.calls[0]?.slice(1, 3)).toEqual(["project-contents", { slug: "p" }]);
    expect(findProjectRooms).toHaveBeenCalledWith("1", ["p", "seen"]);
    const hidden = await httpRequest(server, {
      method: "GET",
      path: "/projects/other/archive-preflight?hostId=5",
    });
    expect(hidden.status).toBe(404);
  });

  it("archive preflight with hidden sub-projects says how many and nothing about what's in them", async () => {
    (getUsernameForUserId as Mock).mockResolvedValue("alice");
    (listProjects as Mock).mockResolvedValue([
      { slug: "p", displayName: "P", users: null, parent: null },
      { slug: "hidden", displayName: "H", users: ["bob"], parent: "p" },
    ]);
    const res = await httpRequest(server, { method: "GET", path: "/projects/p/archive-preflight?hostId=5" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hiddenSubProjects: 1, contents: null, rooms: [], roomsUnknown: false });
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  it("archive preflight says when the chat server couldn't be asked, and passes 'still working' through", async () => {
    (listProjects as Mock).mockResolvedValue([{ slug: "p", displayName: "P", users: null, parent: null }]);
    (findProjectRooms as Mock).mockResolvedValueOnce(null);
    let res = await httpRequest(server, { method: "GET", path: "/projects/p/archive-preflight?hostId=5" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rooms: [], roomsUnknown: true });
    (submitFrontDoor as Mock).mockResolvedValueOnce({ state: "pending", id: "c2", seq: 8, stage: "queued" });
    res = await httpRequest(server, { method: "GET", path: "/projects/p/archive-preflight?hostId=5" });
    expect(res.status).toBe(202);
  });

  it("raw file save that changes the parent gets the move guard rails", async () => {
    (listProjects as Mock).mockResolvedValue([
      { slug: "s", displayName: "S", users: ["bob"], parent: null },
      { slug: "c", displayName: "C", users: null, parent: "s" },
      { slug: "open", displayName: "O", users: null, parent: null },
    ]);
    (readProjectFile as Mock).mockResolvedValue({ markdown: "---\ndisplayName: S\n---\n" });
    const loop = await httpRequest(server, {
      method: "PUT",
      path: "/projects/s/file",
      body: { hostId: 5, contents: "---\ndisplayName: S\nparent: c\n---\n" },
    });
    expect(loop.status).toBe(409);
    const missing = await httpRequest(server, {
      method: "PUT",
      path: "/projects/s/file",
      body: { hostId: 5, contents: "---\nparent: nope\n---\n" },
    });
    expect(missing.status).toBe(400);
    expect(writeProjectFile).not.toHaveBeenCalled();
    const ok = await httpRequest(server, {
      method: "PUT",
      path: "/projects/s/file",
      body: { hostId: 5, contents: "---\nparent: open\n---\n" },
    });
    expect(ok.status).toBe(200);
    expect(writeProjectFile).toHaveBeenCalledTimes(1);
  });

});

describe("cross-cutting", () => {
  it("Test 17: all 3 endpoints under authenticateJWT (401 without header)", async () => {
    mockUserId = null;

    const getRes = await httpRequest(server, {
      method: "GET",
      path: "/projects?hostId=5",
    });
    expect(getRes.status).toBe(401);

    const postRes = await httpRequest(server, {
      method: "POST",
      path: "/projects",
      body: { hostId: 5, displayName: "X" },
    });
    expect(postRes.status).toBe(401);

    const archiveRes = await httpRequest(server, {
      method: "POST",
      path: "/projects/my-project/archive",
      body: { hostId: 5, expected: EXPECTED },
    });
    expect(archiveRes.status).toBe(401);

    // Absolutely no downstream calls happened.
    expect(listProjects).not.toHaveBeenCalled();
    expect(submitFrontDoor).not.toHaveBeenCalled();
  });

  // Test 18 retired: slug derivation now lives in src/backend/utils/
  // pretty-name-slug.ts with its own unit tests. The project create route
  // is tested end-to-end via Tests 9, 11, 11b, 11c.
});

// ===========================================================================
// Per-host SSH semaphore (verify:ssh-cap)
// ===========================================================================

describe("GET /projects — per-host semaphore cap", () => {
  it("10 concurrent remote lists never hold more SSH conns than the cap", async () => {
    __resetHostSemaphoreRegistryForTests();
    getHostSemaphore(7, 3); // pre-seed a small cap for host 7
    let live = 0;
    let peak = 0;
    (connectOneShot as Mock).mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      return {
        exec: vi.fn(),
        end: () => {
          live--;
        },
      };
    });
    (listProjects as Mock).mockImplementation(
      () => new Promise((r) => setTimeout(() => r([]), 5)),
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        httpRequest(server, { method: "GET", path: "/projects?hostId=7" }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(connectOneShot).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(live).toBe(0);
    __resetHostSemaphoreRegistryForTests();
  });

  it("LOCAL host bypasses the semaphore (no slot held, no SSH)", async () => {
    __resetHostSemaphoreRegistryForTests();
    getHostSemaphore(5, 1);
    (listProjects as Mock).mockImplementation(
      () => new Promise((r) => setTimeout(() => r([]), 5)),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        httpRequest(server, { method: "GET", path: "/projects?hostId=5" }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(connectOneShot).not.toHaveBeenCalled();
    __resetHostSemaphoreRegistryForTests();
  });
});
