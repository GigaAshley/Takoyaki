import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
          (req as express.Request & { userId: string }).userId = "user-1";
          next();
        },
    }),
  },
}));

let __activeRow: { id?: string } | undefined = { id: "s-1" };
let __lastGateSql = "";
vi.mock("../db/index.js", () => ({
  db: {
    $client: {
      prepare: (sql: string) => {
        __lastGateSql = sql;
        return { get: () => __activeRow };
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ mxid: "@me_human:hs" }]) }),
      }),
    }),
  },
}));
vi.mock("drizzle-orm", async () => ({
  ...((await vi.importActual("drizzle-orm")) as Record<string, unknown>),
  eq: () => ({}),
}));
vi.mock("../db/schema.js", () => ({ users: { id: "users.id", mxid: "users.mxid" } }));
vi.mock("../../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../relay-room-stream/participants-classifier.js", () => ({
  lookupHumansFromUsersTable: vi.fn().mockResolvedValue(new Map([["@zed_human:hs", {}]])),
}));
vi.mock("../../relay-sessions/relay-room-actions.js", () => ({
  MAX_ROOM_NAME_LENGTH: 255,
  leaveRelayRoom: vi.fn(),
  renameRelayRoom: vi.fn(),
}));

// eslint-disable-next-line import/first
import routes from "./relay-room-actions.js";
// eslint-disable-next-line import/first
import { leaveRelayRoom, renameRelayRoom } from "../../relay-sessions/relay-room-actions.js";

const mockLeave = leaveRelayRoom as unknown as ReturnType<typeof vi.fn>;
const mockRename = renameRelayRoom as unknown as ReturnType<typeof vi.fn>;

let server: http.Server;
let base: string;
const ROOM = encodeURIComponent("!room:hs");

async function post(path: string, body: unknown = {}) {
  return fetch(`${base}/relay-room/${ROOM}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("relay room Leave / Rename routes", () => {
  beforeEach(async () => {
    __activeRow = { id: "s-1" };
    mockLeave.mockReset();
    mockRename.mockReset();
    const app = express();
    app.use(express.json());
    app.use("/relay-room", routes);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("leave acts as the signed-in user's mxid", async () => {
    mockLeave.mockResolvedValue({ ok: true });
    const res = await post("leave");
    expect(res.status).toBe(200);
    expect(mockLeave).toHaveBeenCalledWith("user-1", "@me_human:hs", "!room:hs");
  });

  it("rooms the user isn't active in are 404, gated on the active state", async () => {
    __activeRow = undefined;
    expect((await post("leave")).status).toBe(404);
    expect(__lastGateSql).toContain("state = 'active'");
    expect(mockLeave).not.toHaveBeenCalled();
  });

  it("a malformed room id is 400", async () => {
    const res = await fetch(`${base}/relay-room/not-a-room/leave`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("rename trims, passes a people check, and answers ok", async () => {
    mockRename.mockResolvedValue({ ok: true, granted: true });
    const res = await post("rename", { name: "  Plans  " });
    expect(res.status).toBe(200);
    const [, , , name, isHuman] = mockRename.mock.calls[0];
    expect(name).toBe("Plans");
    expect(isHuman("@zed_human:hs")).toBe(true);
    expect(isHuman("@finch:hs")).toBe(false);
  });

  it("rename refused → 403 not_allowed", async () => {
    mockRename.mockResolvedValue({ ok: false, reason: "not_allowed" });
    const res = await post("rename", { name: "Plans" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed" });
  });

  it("rename other failure → 502", async () => {
    mockRename.mockResolvedValue({ ok: false, reason: "failed", status: 502, error: "x" });
    expect((await post("rename", { name: "Plans" })).status).toBe(502);
  });

  it("empty or overlong names are 400", async () => {
    expect((await post("rename", { name: "   " })).status).toBe(400);
    expect((await post("rename", { name: "x".repeat(256) })).status).toBe(400);
    expect(mockRename).not.toHaveBeenCalled();
  });
});
