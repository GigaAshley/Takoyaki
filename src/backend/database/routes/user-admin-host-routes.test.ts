/**
 * An admin removing a host another user owns: only that user's row goes,
 * with what hangs off it; non-admins and unconfirmed sessions are turned
 * away; a host the user doesn't own is a 404. Runs against a real in-memory
 * database so the cleanup SQL is exercised. The admin and confirm checks are
 * stand-ins driven by request headers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

let sqlite: Database.Database;

const { forceSave, logger } = vi.hoisted(() => ({
  forceSave: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("../db/index.js", () => ({
  db: {
    get $client() {
      return sqlite;
    },
  },
  DatabaseSaveTrigger: { forceSave },
}));
vi.mock("../../utils/logger.js", () => ({ databaseLogger: logger }));
vi.mock("../../utils/recent-auth.js", () => ({
  requireRecentAuth: (
    req: { headers: Record<string, string> },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (req.headers["x-confirmed"] === "1") return next();
    res.status(403).json({ error: "Confirm it's you", code: "REAUTH_REQUIRED" });
  },
}));
vi.mock("axios", () => ({ default: { post: vi.fn().mockResolvedValue({}) } }));

import { registerUserAdminHostRoutes } from "./user-admin-host-routes.js";

const HOST_TABLES = [
  "file_manager_recent",
  "file_manager_pinned",
  "file_manager_shortcuts",
  "command_history",
  "ssh_credential_usage",
  "recent_activity",
  "session_recordings",
  "host_access",
];

function bootstrap(): void {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE ssh_data (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, ip TEXT);
    CREATE TABLE transfer_recent (id INTEGER PRIMARY KEY, source_host_id INTEGER, dest_host_id INTEGER);
  `);
  for (const t of HOST_TABLES) sqlite.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, host_id INTEGER)`);
  sqlite.exec(`
    INSERT INTO users VALUES ('u2', 'beta'), ('other', 'other');
    INSERT INTO ssh_data VALUES (37, 'u2', 'shared-agents', '10.0.0.1'), (38, 'u2', 'keep', '10.0.0.2'), (40, 'other', 'theirs', '10.0.0.3');
    INSERT INTO transfer_recent (source_host_id, dest_host_id) VALUES (37, 38), (38, 37), (38, 40);
  `);
  for (const t of HOST_TABLES) {
    for (const h of [37, 38, 40]) sqlite.prepare(`INSERT INTO ${t} (host_id) VALUES (?)`).run(h);
  }
}

const count = (sql: string) => (sqlite.prepare(sql).get() as { c: number }).c;

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerUserAdminHostRoutes(router, {
    requireAdmin: (req, res, next) => {
      if (req.headers["x-admin"] !== "1") {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      (req as unknown as { userId: string }).userId = "admin-1";
      next();
    },
  });
  app.use("/users", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  sqlite?.close();
  bootstrap();
  vi.clearAllMocks();
  forceSave.mockResolvedValue(undefined);
});

async function remove(userId: string, hostId: string | number, headers: Record<string, string> = { "x-admin": "1", "x-confirmed": "1" }) {
  const res = await fetch(`${base}/users/${userId}/hosts/${hostId}`, { method: "DELETE", headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("admin removes a user's host", () => {
  it("removes the row and everything hanging off it, nothing else", async () => {
    const res = await remove("u2", 37);
    expect(res.status).toBe(200);
    expect(count("SELECT COUNT(*) c FROM ssh_data WHERE id = 37")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM ssh_data")).toBe(2);
    for (const t of HOST_TABLES) {
      expect(count(`SELECT COUNT(*) c FROM ${t} WHERE host_id = 37`)).toBe(0);
      expect(count(`SELECT COUNT(*) c FROM ${t}`)).toBe(2);
    }
    expect(count("SELECT COUNT(*) c FROM transfer_recent")).toBe(1);
    expect(forceSave).toHaveBeenCalledWith("admin_host_remove");
    expect(logger.warn).toHaveBeenCalledWith(
      "Admin removed a user's host",
      expect.objectContaining({
        operation: "admin_host_remove",
        adminId: "admin-1",
        targetUserId: "u2",
        targetUsername: "beta",
        hostId: 37,
        hostName: "shared-agents",
      }),
    );
  });

  it("is refused for a non-admin", async () => {
    const res = await remove("u2", 37, { "x-confirmed": "1" });
    expect(res.status).toBe(403);
    expect(count("SELECT COUNT(*) c FROM ssh_data WHERE id = 37")).toBe(1);
  });

  it("needs a session that recently confirmed it's them", async () => {
    const res = await remove("u2", 37, { "x-admin": "1" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REAUTH_REQUIRED");
    expect(count("SELECT COUNT(*) c FROM ssh_data WHERE id = 37")).toBe(1);
  });

  it("404s for a host the user doesn't own, and leaves the owner's row alone", async () => {
    const res = await remove("u2", 40);
    expect(res.status).toBe(404);
    expect(count("SELECT COUNT(*) c FROM ssh_data WHERE id = 40")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM host_access WHERE host_id = 40")).toBe(1);
  });

  it("404s for a host that doesn't exist", async () => {
    expect((await remove("u2", 999)).status).toBe(404);
  });

  it("400s for a host id that isn't a number", async () => {
    expect((await remove("u2", "abc")).status).toBe(400);
  });

  it("still answers ok when saving to disk fails, and logs it", async () => {
    forceSave.mockRejectedValue(new Error("disk"));
    const res = await remove("u2", 37);
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "Admin host remove: force-save failed",
      expect.objectContaining({ hostId: 37, error: "disk" }),
    );
  });
});
