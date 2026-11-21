/**
 * GET /global-files?hostId=<n> — the configured files, plus what About you
 * needs: where the signed-in person's own file lives, and whether more than
 * one person is on the machine.
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
          (req as express.Request & { userId: string }).userId = "u1";
          next();
        },
    }),
  },
}));
vi.mock("../../ssh/host-resolver.js", () => ({ resolveHostById: vi.fn() }));
vi.mock("../../utils/host-user-counter.js", () => ({ getUsernameForUserId: vi.fn() }));
vi.mock("../../distributor/machine-people.js", () => ({ listMachinePeople: vi.fn() }));
vi.mock("./global-files-config-loader.js", () => ({
  loadGlobalFilesConfig: vi.fn().mockResolvedValue({ hosts: {} }),
  getFilesForHost: vi.fn().mockReturnValue([{ path: "~/.claude/CLAUDE.md" }]),
}));
vi.mock("../../utils/logger.js", () => ({
  sshLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { resolveHostById } from "../../ssh/host-resolver.js";
import { getUsernameForUserId } from "../../utils/host-user-counter.js";
import { listMachinePeople } from "../../distributor/machine-people.js";

const { default: router } = await import("./global-files.js");

let server: http.Server;

function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      })
      .on("error", reject);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveHostById as Mock).mockResolvedValue({ id: 7, name: "thenasty" });
  (getUsernameForUserId as Mock).mockResolvedValue("zoë b");
  const app = express();
  app.use("/global-files", router);
  server = http.createServer(app).listen(0);
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("GET /global-files", () => {
  it("a shared machine: the person's own file and multiUser", async () => {
    (listMachinePeople as Mock).mockResolvedValue([
      { username: "alice", mxid: null },
      { username: "zoë b", mxid: null },
    ]);
    const res = await get("/global-files?hostId=7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      files: [{ path: "~/.claude/CLAUDE.md" }],
      personFile: "~/fleet/people/zo%C3%AB%20b.md",
      multiUser: true,
    });
    expect(listMachinePeople).toHaveBeenCalledWith(7);
  });

  it("one person on the machine: not multiUser, still says where their file is", async () => {
    (listMachinePeople as Mock).mockResolvedValue([{ username: "zoë b", mxid: null }]);
    const res = await get("/global-files?hostId=7");
    expect(res.body.multiUser).toBe(false);
    expect(res.body.personFile).toBe("~/fleet/people/zo%C3%AB%20b.md");
  });

  it("a failing people lookup doesn't take the file list down with it", async () => {
    (listMachinePeople as Mock).mockRejectedValue(new Error("db gone"));
    (getUsernameForUserId as Mock).mockRejectedValue(new Error("db gone"));
    const res = await get("/global-files?hostId=7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [{ path: "~/.claude/CLAUDE.md" }], personFile: null, multiUser: false });
  });

  it("people unknown, username unreadable: no person file, not multiUser", async () => {
    (listMachinePeople as Mock).mockResolvedValue(null);
    (getUsernameForUserId as Mock).mockResolvedValue(null);
    const res = await get("/global-files?hostId=7");
    expect(res.body.multiUser).toBe(false);
    expect(res.body.personFile).toBeNull();
  });
});
