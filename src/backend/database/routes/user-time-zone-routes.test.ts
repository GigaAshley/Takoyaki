/**
 * Person time zone: the backend lookup (utils/person-time-zone.ts) and the
 * signed-in person's routes, against a real in-memory database.
 *
 * Flows: a browser report sets a zone nobody had; a later browser elsewhere
 * moves it; plain UTC never does; a pin holds against every browser and can
 * be UTC; unpinning hands the zone to the browser at once; the lookup says
 * "not set" rather than guessing; bad zones are refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

let sqlite: Database.Database;
let drizzleDb: ReturnType<typeof drizzle>;

vi.mock("../db/index.js", () => ({
  get db() {
    return drizzleDb;
  },
}));
const { forceSave } = vi.hoisted(() => ({ forceSave: vi.fn(async () => {}) }));
vi.mock("../../utils/database-save-trigger.js", () => ({ DatabaseSaveTrigger: { forceSave } }));
vi.mock("../../utils/logger.js", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { authLogger: l };
});

import { registerUserTimeZoneRoutes } from "./user-time-zone-routes.js";
import { getPersonTimeZone, isPlainUtc, isValidTimeZone } from "../../utils/person-time-zone.js";

function bootstrap(): void {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
      time_zone TEXT, time_zone_pinned INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users (id, username) VALUES ('alice', 'alice'), ('robin', 'robin');
  `);
  drizzleDb = drizzle(sqlite);
}

let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerUserTimeZoneRoutes(router, (req, res, next) => {
    const id = req.header("x-test-user-id");
    if (!id) return res.status(401).json({ error: "Unauthorized" });
    (req as express.Request & { userId: string }).userId = id;
    next();
  });
  app.use("/users", router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  bootstrap();
  forceSave.mockClear();
});

function call(method: string, path: string, body?: unknown, userId = "alice"): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: `/users${path}`,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-test-user-id": userId },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const stored = (id = "alice") =>
  sqlite.prepare("SELECT time_zone AS tz, time_zone_pinned AS pinned FROM users WHERE id = ?").get(id) as {
    tz: string | null;
    pinned: number;
  };

describe("the lookup", () => {
  it("says not set rather than guessing, and knows when there's no such person", async () => {
    expect(await getPersonTimeZone("alice")).toEqual({ status: "not_set" });
    expect(await getPersonTimeZone("nobody")).toEqual({ status: "no_such_person" });
  });

  it("answers the zone and whether it's pinned", async () => {
    sqlite.prepare("UPDATE users SET time_zone = 'America/Denver', time_zone_pinned = 1 WHERE id = 'alice'").run();
    expect(await getPersonTimeZone("alice")).toEqual({ status: "set", timeZone: "America/Denver", pinned: true });
  });

  it("knows real zones and plain UTC", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("America/New_York; rm -rf /")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isPlainUtc("Etc/UTC")).toBe(true);
    expect(isPlainUtc("Europe/London")).toBe(false);
  });
});

describe("following the browser", () => {
  it("learns the zone from the first browser, then follows a browser elsewhere", async () => {
    expect((await call("GET", "/me/time-zone")).body).toEqual({ timeZone: null, pinned: false });

    let res = await call("POST", "/me/time-zone/browser", { timeZone: "America/New_York" });
    expect(res).toEqual({ status: 200, body: { timeZone: "America/New_York", pinned: false } });

    res = await call("POST", "/me/time-zone/browser", { timeZone: "America/Denver" });
    expect(res.body).toEqual({ timeZone: "America/Denver", pinned: false });
    expect(stored()).toEqual({ tz: "America/Denver", pinned: 0 });
    expect(forceSave).toHaveBeenCalledTimes(2);
    expect(await getPersonTimeZone("alice")).toEqual({ status: "set", timeZone: "America/Denver", pinned: false });
    // Only the person who reported changed.
    expect(stored("robin")).toEqual({ tz: null, pinned: 0 });
  });

  it("does nothing (and saves nothing) when the browser already matches", async () => {
    await call("POST", "/me/time-zone/browser", { timeZone: "America/New_York" });
    forceSave.mockClear();
    const res = await call("POST", "/me/time-zone/browser", { timeZone: "America/New_York" });
    expect(res.body).toEqual({ timeZone: "America/New_York", pinned: false });
    expect(forceSave).not.toHaveBeenCalled();
  });

  it("never takes plain UTC from a browser", async () => {
    await call("POST", "/me/time-zone/browser", { timeZone: "America/New_York" });
    for (const z of ["UTC", "Etc/UTC", "GMT"]) {
      const res = await call("POST", "/me/time-zone/browser", { timeZone: z });
      expect(res.body).toEqual({ timeZone: "America/New_York", pinned: false });
    }
    // Nor as a first zone.
    const res = await call("POST", "/me/time-zone/browser", { timeZone: "UTC" }, "robin");
    expect(res.body).toEqual({ timeZone: null, pinned: false });
  });

  it("stores a zone in its standard spelling, and keeps older names browsers report", async () => {
    let res = await call("POST", "/me/time-zone/browser", { timeZone: "america/denver" });
    expect(res.body).toEqual({ timeZone: "America/Denver", pinned: false });
    res = await call("PUT", "/me/time-zone/pin", { timeZone: "europe/paris" });
    expect(res.body).toEqual({ timeZone: "Europe/Paris", pinned: true });
    res = await call("POST", "/me/time-zone/browser", { timeZone: "Asia/Calcutta" }, "robin");
    expect(res.body).toEqual({ timeZone: "Asia/Calcutta", pinned: false });
  });

  it("knows plain UTC by every name, whatever the engine resolves it to", async () => {
    for (const z of ["Etc/Zulu", "UCT", "Etc/UCT", "Greenwich", "GMT0"]) expect(isPlainUtc(z)).toBe(true);
    expect(isPlainUtc("Etc/GMT+5")).toBe(false);
  });

  it("refuses something that isn't a time zone", async () => {
    expect((await call("POST", "/me/time-zone/browser", { timeZone: "Nowhere/Special" })).status).toBe(400);
    expect((await call("POST", "/me/time-zone/browser", {})).status).toBe(400);
    expect(stored()).toEqual({ tz: null, pinned: 0 });
  });
});

describe("pinning", () => {
  it("holds against every browser, and can be UTC", async () => {
    let res = await call("PUT", "/me/time-zone/pin", { timeZone: "UTC" });
    expect(res.body).toEqual({ timeZone: "UTC", pinned: true });
    res = await call("POST", "/me/time-zone/browser", { timeZone: "America/Denver" });
    expect(res.body).toEqual({ timeZone: "UTC", pinned: true });
    expect(stored()).toEqual({ tz: "UTC", pinned: 1 });
  });

  it("changing a pin keeps it pinned", async () => {
    await call("PUT", "/me/time-zone/pin", { timeZone: "Asia/Tokyo" });
    const res = await call("PUT", "/me/time-zone/pin", { timeZone: "Europe/Paris" });
    expect(res.body).toEqual({ timeZone: "Europe/Paris", pinned: true });
  });

  it("unpinning hands the zone to this browser at once", async () => {
    await call("PUT", "/me/time-zone/pin", { timeZone: "Asia/Tokyo" });
    const res = await call("DELETE", "/me/time-zone/pin", { browserTimeZone: "America/Chicago" });
    expect(res.body).toEqual({ timeZone: "America/Chicago", pinned: false });
    // …and browsers move it again from then on.
    expect((await call("POST", "/me/time-zone/browser", { timeZone: "America/Denver" })).body).toEqual({
      timeZone: "America/Denver",
      pinned: false,
    });
  });

  it("unpinning from a UTC browser keeps the zone until a real one reports", async () => {
    await call("PUT", "/me/time-zone/pin", { timeZone: "Asia/Tokyo" });
    const res = await call("DELETE", "/me/time-zone/pin", { browserTimeZone: "Etc/UTC" });
    expect(res.body).toEqual({ timeZone: "Asia/Tokyo", pinned: false });
    expect(stored()).toEqual({ tz: "Asia/Tokyo", pinned: 0 });
  });

  it("refuses a pin that isn't a time zone", async () => {
    expect((await call("PUT", "/me/time-zone/pin", { timeZone: "" })).status).toBe(400);
    expect((await call("DELETE", "/me/time-zone/pin", { browserTimeZone: "Nope/Nope" })).status).toBe(400);
  });
});

describe("who it applies to", () => {
  it("404s for a person who doesn't exist and 401s without a sign-in", async () => {
    expect((await call("GET", "/me/time-zone", undefined, "ghost")).status).toBe(404);
    expect((await call("POST", "/me/time-zone/browser", { timeZone: "America/Denver" }, "ghost")).status).toBe(404);
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((r) =>
      http.get({ hostname: "127.0.0.1", port, path: "/users/me/time-zone" }, (res) => r(res.statusCode ?? 0)),
    );
    expect(status).toBe(401);
  });
});
