/**
 * useRelayAdapter — files in relay rooms: file posts map to file chips, and
 * sendFiles sends files in order, then the typed text, marking the first
 * failure and everything after it not sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderHook, act } from "@testing-library/react";

const sendRelayRoomFile = vi.hoisted(() => vi.fn());
vi.mock("@/api/relay-room-files-api", async () => {
  class RelayRoomFileSendError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
    }
  }
  return { sendRelayRoomFile, RelayRoomFileSendError };
});

import type { MatrixEvent, RelayRoomServerEvent } from "./relay-room-api";

// ── Minimal WebSocket mock ───────────────────────────────────────────────────
// The hook constructs `new WebSocket(url)` via openRelayRoomSocket(). We
// vi.stubGlobal the constructor so tests can drive readyState + onopen/
// onmessage/onclose synchronously via helper methods.

interface MockWebSocketInstance {
  url: string;
  readyState: number;
  sent: string[];
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent<string>) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  // Test helpers
  simulateOpen(): void;
  simulateFrame(frame: RelayRoomServerEvent): void;
  simulateClose(code?: number): void;
}

let instances: MockWebSocketInstance[] = [];

function makeMockWebSocket(url: string): MockWebSocketInstance {
  const ws: MockWebSocketInstance = {
    url,
    readyState: 0, // CONNECTING
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close(_code?: number, _reason?: string) {
      if (this.readyState === 3) return;
      this.readyState = 3; // CLOSED
    },
    send(data: string) {
      this.sent.push(data);
    },
    simulateOpen() {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen(new Event("open"));
    },
    simulateFrame(frame: RelayRoomServerEvent) {
      if (this.onmessage) {
        const evt = new MessageEvent("message", {
          data: JSON.stringify(frame),
        });
        this.onmessage(evt);
      }
    },
    simulateClose(code: number = 1006) {
      this.readyState = 3;
      if (this.onclose) {
        const evt = { code, reason: "" } as CloseEvent;
        this.onclose(evt);
      }
    },
  };
  return ws;
}

class MockWebSocketCtor {
  constructor(url: string) {
    const inst = makeMockWebSocket(url);
    instances.push(inst);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return inst as any;
  }
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
}

// Mock the viewing-user-store so the hook resolves the viewer mxid + id
// without hitting the real store.
const VIEWING_MXID = "@alex:matrix.example.com";
vi.mock("@/state/viewing-user-store", () => ({
  useViewingUserMxid: () => VIEWING_MXID,
  useViewingUserId: () => "user-42",
}));

beforeEach(() => {
  instances = [];
  sendRelayRoomFile.mockReset();
  vi.stubGlobal("WebSocket", MockWebSocketCtor);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { useRelayAdapter } from "./use-relay-adapter";
import { RelayRoomFileSendError } from "@/api/relay-room-files-api";

const ROOM_ID = "!room:matrix.example.com";
const OTHER_MXID = "@tina:matrix.example.com";
const SOURCE = { kind: "relay" as const, roomId: ROOM_ID, roomTitle: "Plans" };

function open() {
  const hook = renderHook(() => useRelayAdapter(SOURCE, true));
  act(() => {
    instances[0].simulateOpen();
    instances[0].simulateFrame({ type: "history_batch", events: [], hasMore: false });
  });
  return hook;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const file = (name: string, type = "text/plain") => new File(["abc"], name, { type });

describe("relay room files — showing posts", () => {
  it("someone else's picture becomes an inbound bubble carrying a room file", () => {
    const { result } = open();
    const ev: MatrixEvent = {
      event_id: "$pic",
      type: "m.room.message",
      sender: OTHER_MXID,
      origin_server_ts: 1,
      content: { msgtype: "m.image", body: "cat.png", url: "mxc://hs/abc", info: { mimetype: "image/png", size: 12 } },
    };
    act(() => instances[0].simulateFrame({ type: "live_event", event: ev }));
    const m = result.current.messages[0];
    expect(m.type).toBe("relay_inbound");
    if (m.type !== "relay_inbound") return;
    expect(m.body).toBe("cat.png");
    expect(m.roomFile?.name).toBe("cat.png");
    expect(m.roomFile?.size).toBe(12);
    expect(m.roomFile?.url).toContain("/file/.relay-room/");
    expect(m.roomFile?.url).toContain(encodeURIComponent("$pic"));
  });

  it("an encrypted attachment still shows, as a file that can't be opened", () => {
    const { result } = open();
    const ev: MatrixEvent = {
      event_id: "$enc",
      type: "m.room.message",
      sender: OTHER_MXID,
      origin_server_ts: 1,
      content: { msgtype: "m.file", body: "secret.pdf", file: { url: "mxc://hs/x" } },
    };
    act(() => instances[0].simulateFrame({ type: "live_event", event: ev }));
    const m = result.current.messages[0];
    if (m.type !== "relay_inbound") throw new Error("expected inbound");
    expect(m.roomFile?.url).toBeNull();
    expect(m.roomFile?.unavailable).toBe("encrypted");
  });

  it("the user's own file post is their own bubble with the file", () => {
    const { result } = open();
    const ev: MatrixEvent = {
      event_id: "$mine",
      type: "m.room.message",
      sender: VIEWING_MXID,
      origin_server_ts: 1,
      content: { msgtype: "m.file", body: "notes.txt", url: "mxc://hs/n" },
    };
    act(() => instances[0].simulateFrame({ type: "live_event", event: ev }));
    const m = result.current.messages[0];
    expect(m.type).toBe("message");
    if (m.type !== "message") return;
    expect(m.role).toBe("user");
    expect(m.roomFile?.name).toBe("notes.txt");
  });
});

describe("relay room files — sendFiles", () => {
  it("shows every file and the text at once, sends files in order, then the text", async () => {
    let release!: () => void;
    sendRelayRoomFile.mockImplementation(async (_room: string, f: File, txn: string) => {
      if (f.name === "a.txt") await new Promise<void>((r) => { release = r; });
      return { eventId: `$${f.name}`, content: { msgtype: "m.file", body: f.name, url: `mxc://hs/${txn}` } };
    });
    const { result } = open();
    let done!: Promise<void>;
    act(() => {
      done = result.current.sendFiles!([file("a.txt"), file("b.txt")], "here you go");
    });
    // Three bubbles on the user's side straight away, all sending.
    const pending = result.current.messages.filter((m) => m.type === "message");
    expect(pending).toHaveLength(3);
    expect(pending.every((m) => m.type === "message" && m.pendingState === "sending")).toBe(true);
    expect(sendRelayRoomFile).toHaveBeenCalledTimes(1);
    expect(instances[0].sent.some((s) => s.includes("send_message"))).toBe(false);

    await act(async () => {
      release();
      await done;
    });
    expect(sendRelayRoomFile.mock.calls.map((c) => (c[1] as File).name)).toEqual(["a.txt", "b.txt"]);
    const textSends = instances[0].sent.map((s) => JSON.parse(s)).filter((p) => p.type === "send_message");
    expect(textSends).toHaveLength(1);
    expect(textSends[0].body).toBe("here you go");
    // Sent files are now real posts with file chips; the text still pending.
    const files = result.current.messages.filter((m) => m.type === "message" && m.roomFile);
    expect(files.map((m) => (m.type === "message" ? m.roomFile?.name : ""))).toEqual(["a.txt", "b.txt"]);
  });

  it("a failed file marks it, later files and the text not sent — and sends none of them", async () => {
    sendRelayRoomFile.mockImplementation(async (_room: string, f: File) => {
      if (f.name === "a.txt") return { eventId: "$a", content: { msgtype: "m.file", body: "a.txt", url: "mxc://hs/a" } };
      throw new RelayRoomFileSendError("host_unreachable");
    });
    const { result } = open();
    await act(async () => {
      await result.current.sendFiles!([file("a.txt"), file("b.txt"), file("c.txt")], "caption");
      await flush();
    });
    expect(sendRelayRoomFile).toHaveBeenCalledTimes(2);
    const failed = result.current.messages.filter((m) => m.type === "message" && m.pendingState === "failed");
    expect(failed).toHaveLength(3); // b, c, and the caption
    expect(instances[0].sent.some((s) => s.includes("send_message"))).toBe(false);
    const sent = result.current.messages.filter((m) => m.type === "message" && m.roomFile);
    expect(sent).toHaveLength(1);
  });

  it("files with no text send no text message", async () => {
    sendRelayRoomFile.mockResolvedValue({ eventId: "$x", content: { msgtype: "m.image", body: "x.png", url: "mxc://hs/x" } });
    const { result } = open();
    await act(async () => {
      await result.current.sendFiles!([file("x.png", "image/png")], "   ");
    });
    expect(instances[0].sent.some((s) => s.includes("send_message"))).toBe(false);
    expect(result.current.messages.filter((m) => m.type === "message")).toHaveLength(1);
  });
});
