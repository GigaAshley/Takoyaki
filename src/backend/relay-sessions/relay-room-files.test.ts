import { describe, it, expect, vi, beforeEach } from "vitest";

const media = vi.hoisted(() => ({
  getMediaConfigAsUser: vi.fn(),
  getRoomEventAsUser: vi.fn(),
  openMediaDownloadAsUser: vi.fn(),
  sendRoomEventAsUser: vi.fn(),
  uploadMediaAsUser: vi.fn(),
}));
vi.mock("../matrix/matrix-room-media-client.js", async () => ({
  ...media,
  parseMxc: (m: string) => (/^mxc:\/\/[^/]+\/[^/]+$/.test(m) ? { server: "hs", mediaId: "x" } : null),
}));
const caller = vi.hoisted(() => ({ resolveRoomCallerMxid: vi.fn() }));
vi.mock("./relay-room-caller.js", () => caller);
vi.mock("../utils/logger.js", () => ({
  databaseLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkRoomFile,
  cleanFileName,
  describeFilePost,
  msgtypeForMime,
  openRoomFile,
  parseRoomFilePath,
  readRoomFile,
  sendRoomFile,
} from "./relay-room-files.js";

const ROOM = "!room:hs";
const ADDR = { roomId: ROOM, eventId: "$ev:hs" };
let n = 0;

function filePost(content: Record<string, unknown>) {
  return { ok: true, event: { type: "m.room.message", event_id: "$ev:hs", content } };
}

beforeEach(() => {
  for (const f of Object.values(media)) f.mockReset();
  caller.resolveRoomCallerMxid.mockReset().mockResolvedValue("@me:hs");
  // A fresh user each test so the upload-limit cache never carries over.
  caller.resolveRoomCallerMxid.mockResolvedValue(`@me${++n}:hs`);
  media.getMediaConfigAsUser.mockResolvedValue({ ok: true, maxUploadBytes: 100 });
});

describe("room file addresses", () => {
  it("parse to the room and the post", () => {
    expect(parseRoomFilePath(`/${ROOM}/$ev:hs/cat.png`)).toEqual(ADDR);
  });
  it("refuse anything that isn't a room and an event", () => {
    expect(parseRoomFilePath("/home/ubuntu/x")).toBeNull();
    expect(parseRoomFilePath(`/${ROOM}`)).toBeNull();
    expect(parseRoomFilePath(`/${ROOM}/not-an-event/x`)).toBeNull();
  });
});

describe("file posts", () => {
  it("are recognised with name, size and type", () => {
    expect(
      describeFilePost({
        type: "m.room.message",
        content: { msgtype: "m.image", body: "a.png", url: "mxc://hs/a", info: { size: 5, mimetype: "image/png" } },
      }),
    ).toEqual({ name: "a.png", mimetype: "image/png", size: 5, mxc: "mxc://hs/a", encrypted: false });
  });
  it("text messages aren't file posts", () => {
    expect(describeFilePost({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } })).toBeNull();
  });
  it("an encrypted attachment is marked so", () => {
    expect(
      describeFilePost({ type: "m.room.message", content: { msgtype: "m.file", body: "s", file: {} } })?.encrypted,
    ).toBe(true);
  });
  it("map types to the post kind agents use", () => {
    expect(msgtypeForMime("image/png")).toBe("m.image");
    expect(msgtypeForMime("audio/ogg")).toBe("m.audio");
    expect(msgtypeForMime("video/mp4")).toBe("m.video");
    expect(msgtypeForMime("application/pdf")).toBe("m.file");
  });
  it("names are kept to one safe line", () => {
    expect(cleanFileName("a/b\\c\n.txt")).toBe("a b c .txt");
    expect(cleanFileName("   ")).toBe("file");
  });
});

describe("opening a room file", () => {
  it("someone not active in the room gets not_found, and the chat server isn't asked", async () => {
    caller.resolveRoomCallerMxid.mockResolvedValue(null);
    const r = await openRoomFile("u1", ADDR);
    expect(r).toMatchObject({ ok: false, errorClass: "not_found", status: 404 });
    expect(media.getRoomEventAsUser).not.toHaveBeenCalled();
  });
  it("the event is read as the user, and its own file is what's fetched", async () => {
    media.getRoomEventAsUser.mockResolvedValue(filePost({ msgtype: "m.file", body: "a.txt", url: "mxc://hs/a" }));
    const response = new Response("hi");
    media.openMediaDownloadAsUser.mockResolvedValue({ ok: true, response });
    const r = await openRoomFile("u1", ADDR, "bytes=0-1");
    expect(r.ok).toBe(true);
    const mxid = media.getRoomEventAsUser.mock.calls[0][0];
    expect(media.getRoomEventAsUser).toHaveBeenCalledWith(mxid, ROOM, "$ev:hs");
    expect(media.openMediaDownloadAsUser).toHaveBeenCalledWith(mxid, "mxc://hs/a", "bytes=0-1");
  });
  it("an event the server won't show is not_found", async () => {
    media.getRoomEventAsUser.mockResolvedValue({ ok: false, status: 404, error: "x" });
    expect(await openRoomFile("u1", ADDR)).toMatchObject({ ok: false, errorClass: "not_found" });
  });
  it("a text message is not_a_file; an encrypted one says so", async () => {
    media.getRoomEventAsUser.mockResolvedValue(filePost({ msgtype: "m.text", body: "hi" }));
    expect(await openRoomFile("u1", ADDR)).toMatchObject({ errorClass: "not_a_file" });
    media.getRoomEventAsUser.mockResolvedValue(filePost({ msgtype: "m.file", body: "s", file: {} }));
    expect(await openRoomFile("u1", ADDR)).toMatchObject({ errorClass: "room_file_encrypted" });
  });
  it("a file gone from the chat server is not_found", async () => {
    media.getRoomEventAsUser.mockResolvedValue(filePost({ msgtype: "m.file", body: "a", url: "mxc://hs/a" }));
    media.openMediaDownloadAsUser.mockResolvedValue({ ok: false, status: 404, error: "x" });
    expect(await checkRoomFile("u1", ADDR)).toMatchObject({ ok: false, errorClass: "not_found" });
  });
  it("reading whole refuses a file past the cap", async () => {
    media.getRoomEventAsUser.mockResolvedValue(
      filePost({ msgtype: "m.file", body: "a", url: "mxc://hs/a", info: { size: 10 } }),
    );
    expect(await readRoomFile("u1", ADDR, 5)).toMatchObject({ errorClass: "too_large" });
    media.getRoomEventAsUser.mockResolvedValue(filePost({ msgtype: "m.file", body: "a", url: "mxc://hs/a" }));
    media.openMediaDownloadAsUser.mockResolvedValue({ ok: true, response: new Response("0123456789") });
    expect(await readRoomFile("u1", ADDR, 5)).toMatchObject({ errorClass: "too_large" });
    media.openMediaDownloadAsUser.mockResolvedValue({ ok: true, response: new Response("0123") });
    const ok = await readRoomFile("u1", ADDR, 5);
    expect(ok.ok === true && ok.bytes.toString()).toBe("0123");
  });
});

describe("sending a room file", () => {
  const file = (size = 10) => ({
    bytes: Buffer.alloc(size, 1),
    filename: "pic.png",
    contentType: "image/png",
    txnId: "txn-1",
  });

  it("uploads as the user and posts an image message like agents send", async () => {
    media.uploadMediaAsUser.mockResolvedValue({ ok: true, mxc: "mxc://hs/new" });
    media.sendRoomEventAsUser.mockResolvedValue({ ok: true, eventId: "$sent" });
    const r = await sendRoomFile("u1", ROOM, file());
    expect(r.ok).toBe(true);
    const [mxid, roomId, content, txn] = media.sendRoomEventAsUser.mock.calls[0];
    expect(mxid).toMatch(/^@me/);
    expect(roomId).toBe(ROOM);
    expect(txn).toBe("txn-1");
    expect(content).toEqual({
      msgtype: "m.image",
      body: "pic.png",
      filename: "pic.png",
      url: "mxc://hs/new",
      info: { mimetype: "image/png", size: 10 },
    });
  });
  it("a file over the server's limit is refused before any upload", async () => {
    const r = await sendRoomFile("u1", ROOM, file(101));
    expect(r).toMatchObject({ ok: false, errorClass: "too_large", status: 413 });
    expect(media.uploadMediaAsUser).not.toHaveBeenCalled();
  });
  it("someone not in the room can't send", async () => {
    caller.resolveRoomCallerMxid.mockResolvedValue(null);
    expect(await sendRoomFile("u1", ROOM, file())).toMatchObject({ errorClass: "not_found" });
    expect(media.uploadMediaAsUser).not.toHaveBeenCalled();
  });
  it("an odd type is sent as a plain file; a bad txn id is refused", async () => {
    media.uploadMediaAsUser.mockResolvedValue({ ok: true, mxc: "mxc://hs/new" });
    media.sendRoomEventAsUser.mockResolvedValue({ ok: true, eventId: "$sent" });
    await sendRoomFile("u1", ROOM, { ...file(), contentType: "not a type" });
    expect(media.uploadMediaAsUser.mock.calls[0][3]).toBe("application/octet-stream");
    expect(await sendRoomFile("u1", ROOM, { ...file(), txnId: "bad id/" })).toMatchObject({
      errorClass: "invalid_txn_id",
    });
  });
});
