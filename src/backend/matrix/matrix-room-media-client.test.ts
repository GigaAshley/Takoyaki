import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./matrix-admin-creds-store.js", () => ({
  getMatrixAdminCreds: vi.fn().mockResolvedValue({ homeserverBase: "http://hs", accessToken: "admin" }),
}));
const tokens = vi.hoisted(() => ({ ensureUserToken: vi.fn(), evictUserToken: vi.fn() }));
vi.mock("./matrix-admin-client.js", () => tokens);
vi.mock("../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getMediaConfigAsUser,
  openMediaDownloadAsUser,
  parseMxc,
  sendRoomEventAsUser,
  uploadMediaAsUser,
} from "./matrix-room-media-client.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  tokens.ensureUserToken.mockReset().mockResolvedValue({ ok: true, token: "tok" });
  tokens.evictUserToken.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("matrix room media client", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://hs.example/abc")).toEqual({ server: "hs.example", mediaId: "abc" });
    expect(parseMxc("https://x/y")).toBeNull();
  });

  it("reads the upload limit, falling back to the legacy endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    fetchMock.mockResolvedValueOnce(json({ "m.upload.size": 52428800 }));
    expect(await getMediaConfigAsUser("@u:hs")).toEqual({ ok: true, maxUploadBytes: 52428800 });
    expect(fetchMock.mock.calls[1][0]).toBe("http://hs/_matrix/media/v3/config");
  });

  it("uploads with the user's token and returns the mxc", async () => {
    fetchMock.mockResolvedValueOnce(json({ content_uri: "mxc://hs/new" }));
    const r = await uploadMediaAsUser("@u:hs", Buffer.from("abc"), 3, "a b.png", "image/png");
    expect(r).toEqual({ ok: true, mxc: "mxc://hs/new" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://hs/_matrix/media/v3/upload?filename=a%20b.png");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("image/png");
  });

  it("retries once with a fresh token on 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    fetchMock.mockResolvedValueOnce(json({ event_id: "$e" }));
    expect(await sendRoomEventAsUser("@u:hs", "!r:hs", { msgtype: "m.file" }, "t1")).toEqual({
      ok: true,
      eventId: "$e",
    });
    expect(tokens.evictUserToken).toHaveBeenCalledWith("@u:hs");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://hs/_matrix/client/v3/rooms/!r%3Ahs/send/m.room.message/t1",
    );
  });

  it("downloads through the authenticated endpoint, passing Range", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ab", { status: 206 }));
    const r = await openMediaDownloadAsUser("@u:hs", "mxc://hs/abc", "bytes=0-1");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://hs/_matrix/client/v1/media/download/hs/abc");
    expect(init.headers.Range).toBe("bytes=0-1");
  });

  it("a missing file is missing — a non-404 failure isn't retried on the legacy endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await openMediaDownloadAsUser("@u:hs", "mxc://hs/abc")).toMatchObject({ ok: false, status: 404 });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await openMediaDownloadAsUser("@u:hs", "mxc://hs/abc")).toMatchObject({ ok: false, status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
