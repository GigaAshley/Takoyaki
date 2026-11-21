import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const files = vi.hoisted(() => ({
  openRoomFile: vi.fn(),
  readRoomFile: vi.fn(),
}));
vi.mock("../../relay-sessions/relay-room-files.js", async () => {
  const actual = (await vi.importActual("../../relay-sessions/relay-room-files.js")) as Record<string, unknown>;
  return { parseRoomFilePath: actual.parseRoomFilePath, ...files };
});
vi.mock("../../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sshLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dispatchRoomFile, serveRoomFileGet, serveRoomFilePost } from "./relay-room-file-serve.js";

const PATH = "/!room:hs/$ev:hs/whatever.bin";

async function serve(handler: express.RequestHandler, run: (base: string) => Promise<void>) {
  const app = express();
  app.get("/x", handler);
  const server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => {
  files.openRoomFile.mockReset();
  files.readRoomFile.mockReset();
});

describe("room file content types", () => {
  it("go by the file's name first, with html / svg forced to download", () => {
    expect(dispatchRoomFile("a.png", null)).toEqual({ contentType: "image/png", disposition: "inline" });
    expect(dispatchRoomFile("a.svg", "image/png").disposition).toBe("attachment");
    expect(dispatchRoomFile("a.html", null).disposition).toBe("attachment");
  });
  it("fall back to the declared type only when it's safe to show", () => {
    expect(dispatchRoomFile("photo", "image/jpeg")).toEqual({ contentType: "image/jpeg", disposition: "inline" });
    expect(dispatchRoomFile("page", "text/html")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
    expect(dispatchRoomFile("blob", null).disposition).toBe("attachment");
  });
});

describe("serving a room file", () => {
  it("streams the chat server's bytes with the post's name driving the type", async () => {
    files.openRoomFile.mockResolvedValue({
      ok: true,
      post: { name: "cat.png", mimetype: "image/png", size: 3, mxc: "mxc://hs/c", encrypted: false },
      response: new Response("PNG", { status: 200, headers: { "content-length": "3" } }),
    });
    await serve(
      (req, res) => void serveRoomFileGet(req, res, "u1", PATH),
      async (base) => {
        const res = await fetch(`${base}/x`, { headers: { Range: "bytes=0-2" } });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toBe("PNG");
      },
    );
    expect(files.openRoomFile).toHaveBeenCalledWith("u1", { roomId: "!room:hs", eventId: "$ev:hs" }, "bytes=0-2");
  });

  it("passes a partial answer through for scrubbing", async () => {
    files.openRoomFile.mockResolvedValue({
      ok: true,
      post: { name: "v.mp4", mimetype: "video/mp4", size: 10, mxc: "mxc://hs/v", encrypted: false },
      response: new Response("01", { status: 206, headers: { "content-range": "bytes 0-1/10", "content-length": "2" } }),
    });
    await serve(
      (req, res) => void serveRoomFileGet(req, res, "u1", PATH),
      async (base) => {
        const res = await fetch(`${base}/x`, { headers: { Range: "bytes=0-1" } });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
      },
    );
  });

  it("answers a classified error and nothing else when it can't be opened", async () => {
    files.openRoomFile.mockResolvedValue({ ok: false, errorClass: "not_found", status: 404 });
    await serve(
      (req, res) => void serveRoomFileGet(req, res, "u1", PATH),
      async (base) => {
        const res = await fetch(`${base}/x`);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("not_found");
      },
    );
  });

  it("a path that isn't a room file is not_found without asking anyone", async () => {
    await serve(
      (req, res) => void serveRoomFileGet(req, res, "u1", "/etc/passwd"),
      async (base) => {
        expect((await fetch(`${base}/x`)).status).toBe(404);
      },
    );
    expect(files.openRoomFile).not.toHaveBeenCalled();
  });

  it("the viewer's envelope carries the bytes and the post's name", async () => {
    files.readRoomFile.mockResolvedValue({
      ok: true,
      post: { name: "notes.md", mimetype: "text/markdown", size: 2, mxc: "mxc://hs/n", encrypted: false },
      bytes: Buffer.from("# h"),
    });
    await serve(
      (_req, res) => void serveRoomFilePost(res, "u1", PATH, 2_000_000),
      async (base) => {
        const body = (await (await fetch(`${base}/x`)).json()) as Record<string, unknown>;
        expect(body.filename).toBe("notes.md");
        expect(Buffer.from(body.contentBase64 as string, "base64").toString()).toBe("# h");
        expect(body.extension).toBe("md");
      },
    );
    expect(files.readRoomFile).toHaveBeenCalledWith("u1", { roomId: "!room:hs", eventId: "$ev:hs" }, 2_000_000);
  });
});
