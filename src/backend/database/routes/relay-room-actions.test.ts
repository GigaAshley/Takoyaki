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

const files = vi.hoisted(() => ({
  checkRoomFile: vi.fn(),
  getRoomUploadLimit: vi.fn(),
  sendRoomFile: vi.fn(),
}));
vi.mock("../../relay-sessions/relay-room-files.js", () => files);

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
    for (const f of Object.values(files)) f.mockReset();
    files.getRoomUploadLimit.mockResolvedValue({ ok: true, maxUploadBytes: 8 });
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

  it("rename keeps a name to one line", async () => {
    mockRename.mockResolvedValue({ ok: true, granted: false });
    await post("rename", { name: "Launch\n\tplans\u0007 now" });
    expect(mockRename.mock.calls[0][3]).toBe("Launch plans now");
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

  it("upload-limit answers the chat server's limit", async () => {
    const res = await fetch(`${base}/relay-room/${ROOM}/upload-limit`);
    expect(await res.json()).toEqual({ maxUploadBytes: 8 });
  });

  it("files: sends the body's bytes with the name, type and txn id", async () => {
    let streamed = "";
    files.sendRoomFile.mockImplementation(async (_u: string, _r: string, f: { body: NodeJS.ReadableStream }) => {
      for await (const c of f.body) streamed += c.toString();
      return { ok: true, sent: { eventId: "$e", content: { msgtype: "m.file" } } };
    });
    const res = await fetch(
      `${base}/relay-room/${ROOM}/files?filename=a.txt&type=text%2Fplain&txnId=t1`,
      { method: "POST", headers: { "Content-Type": "application/x-relay-room-file" }, body: "hello" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eventId: "$e", content: { msgtype: "m.file" } });
    const [userId, roomId, f] = files.sendRoomFile.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(roomId).toBe("!room:hs");
    expect(f).toMatchObject({ size: 5, filename: "a.txt", contentType: "text/plain", txnId: "t1" });
    expect(streamed).toBe("hello");
  });

  it("files: a body past the room's limit is 413 and never sent", async () => {
    const res = await fetch(`${base}/relay-room/${ROOM}/files?filename=a.txt&txnId=t1`, {
      method: "POST",
      headers: { "Content-Type": "application/x-relay-room-file" },
      body: "123456789",
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(files.sendRoomFile).not.toHaveBeenCalled();
  });

  it("files: rooms the user isn't active in are 404", async () => {
    __activeRow = undefined;
    const res = await fetch(`${base}/relay-room/${ROOM}/files?filename=a.txt&txnId=t1`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(404);
    expect(files.sendRoomFile).not.toHaveBeenCalled();
  });

  it("file status passes the reason a file can't be opened", async () => {
    files.checkRoomFile.mockResolvedValue({ ok: false, errorClass: "not_found", status: 404 });
    const res = await fetch(`${base}/relay-room/${ROOM}/files/${encodeURIComponent("$e:hs")}/status`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(files.checkRoomFile).toHaveBeenCalledWith("user-1", { roomId: "!room:hs", eventId: "$e:hs" });
  });
});
