/**
 * POST /identities/:key/condense — Compact conversation, a request to the machine's front
 * door (fleet-change agent-compact). Auth, the machine connection and the front door are
 * mocked; the front door's own behaviour is fleet-change.test.sh's.
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

import { submitFrontDoor } from "../../fleet-change/front-door.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import router, { GUIDANCE_MAX_BYTES, normalizeGuidance } from "./identity-condense.js";

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
  (withHost as Mock).mockImplementation(async (_h: number, _u: string, fn: (c: unknown) => Promise<unknown>) => fn(conn));
  answer({ state: "done", result: { name: "alpha" } });
  const app = express();
  app.use(express.json());
  app.use("/identities", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
});

afterEach(() => server?.close());

describe("POST /identities/:key/condense", () => {
  it("asks the front door, with no guidance when none was typed", async () => {
    const r = await call(server, "/identities/alpha/condense", { hostId: 5, requestId: "press-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, requestId: "press-1" });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-compact", { name: "alpha" }, { id: "press-1", hostId: 5, by: "1" });
  });

  it("guidance is flattened to one line", async () => {
    await call(server, "/identities/alpha/condense", { hostId: 5, guidance: "keep the\nfailing   test" });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-compact", { name: "alpha", guidance: "keep the failing test" }, expect.anything());
  });

  it("non-string guidance is ignored", async () => {
    await call(server, "/identities/alpha/condense", { hostId: 5, guidance: 42 });
    expect(submitFrontDoor).toHaveBeenCalledWith(conn, "agent-compact", { name: "alpha" }, expect.anything());
  });

  it("passes the machine's refusal on (being archived)", async () => {
    answer({ state: "refused", code: "being_archived", reason: "it's being archived" });
    const r = await call(server, "/identities/alpha/condense", { hostId: 5 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "being_archived", error: "it's being archived" });
  });

  it("answers 202 while it waits its turn, 503 while the machine updates", async () => {
    answer({ state: "pending", stage: "queued" });
    expect((await call(server, "/identities/alpha/condense", { hostId: 5 })).body).toMatchObject({ pending: true });
    (submitFrontDoor as Mock).mockImplementation(async (_c: unknown, _k: string, _a: unknown, o: { id: string }) => ({ id: o.id, state: "not_installed" }));
    expect((await call(server, "/identities/alpha/condense", { hostId: 5 })).status).toBe(503);
  });

  it("validates before touching the machine", async () => {
    expect((await call(server, "/identities/alpha/condense", {})).status).toBe(400);
    expect((await call(server, "/identities/alpha/condense", { hostId: 0 })).status).toBe(400);
    expect((await call(server, "/identities/Bad.Key/condense", { hostId: 5 })).status).toBe(400);
    expect(withHost).not.toHaveBeenCalled();
  });

  it("maps an unknown host and an unreachable one; refuses no login", async () => {
    (withHost as Mock).mockRejectedValueOnce(new HttpError(404, "Host not found"));
    expect((await call(server, "/identities/alpha/condense", { hostId: 5 })).status).toBe(404);
    (withHost as Mock).mockRejectedValueOnce(new HttpError(504, "Host unreachable"));
    expect((await call(server, "/identities/alpha/condense", { hostId: 5 })).status).toBe(504);
    mockUserId = null;
    expect((await call(server, "/identities/alpha/condense", { hostId: 5 })).status).toBe(401);
  });
});

describe("normalizeGuidance", () => {
  it("cuts to fit the machine's byte cap, on whole characters", () => {
    const out = normalizeGuidance("é".repeat(GUIDANCE_MAX_BYTES));
    expect(Buffer.byteLength(out, "utf8")).toBe(GUIDANCE_MAX_BYTES);
    expect(out).toBe("é".repeat(GUIDANCE_MAX_BYTES / 2));
    expect(Buffer.byteLength(normalizeGuidance("a" + "é".repeat(GUIDANCE_MAX_BYTES)), "utf8")).toBe(GUIDANCE_MAX_BYTES - 1);
  });
  it("leaves guidance under the cap alone", () => {
    const fits = "k".repeat(GUIDANCE_MAX_BYTES);
    expect(normalizeGuidance(fits)).toBe(fits);
  });
  it("drops control characters (an ESC sequence can't end the paste early)", () => {
    expect(normalizeGuidance("keep\u001b[201~ this\u0001")).toBe("keep[201~ this");
  });
  it("empty / whitespace / non-string → empty", () => {
    expect(normalizeGuidance("  \n ")).toBe("");
    expect(normalizeGuidance(undefined)).toBe("");
    expect(normalizeGuidance(42)).toBe("");
  });
});
