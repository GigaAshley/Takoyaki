// A relay room conversation with files, driven end to end through the
// real composer and bubbles (only the room's connection is stubbed): file
// posts show as file chips, the paperclip stages files with the room's
// limit, and Send hands files + text to the room.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Identity } from "@/api/identities-api";

type WsStub = {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent<string>) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
const wsStubs: WsStub[] = [];

vi.mock("@/api/claude-session-api", () => ({
  openClaudeSessionSocket: vi.fn(() => {
    const ws: WsStub = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onerror: null,
      onclose: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    wsStubs.push(ws);
    return ws;
  }),
}));

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));

const useSessionIdentityMock = vi.fn(() => ({
  identity: null as unknown,
  identityHue: null as number | null,
}));
const sessionMatchKeyMock = vi.fn(() => null as string | null);

vi.mock("@/features/terminal/session-hue", () => ({
  sessionMatchKey: (name: string | null | undefined) =>
    sessionMatchKeyMock(name as unknown as never),
  useSessionIdentity: (name: string | null | undefined) =>
    useSessionIdentityMock(name as unknown as never),
}));

// TaskPill mock — the harness pane's handle (replaced the harness badge).
vi.mock("./TaskPill", () => ({
  TaskPill: (props: { identityKey: string }) => (
    <div data-testid="mock-task-pill" data-identity-key={props.identityKey} />
  ),
}));

vi.mock("@/features/terminal/IdentityBadge", () => ({
  IdentityBadge: (props: { identityKey: string | null }) =>
    props.identityKey ? (
      <div
        data-testid="mock-identity-badge"
        className="pv-identity-breathe absolute top-4 right-5 z-[101]"
        data-identity-key={props.identityKey}
      />
    ) : null,
}));

vi.mock("@/hooks/use-is-touch-device", () => ({
  useIsTouchDevice: vi.fn(() => false),
}));

// Viewing user mock — used by both adapter and MultiBadgeAnchor.
vi.mock("@/state/viewing-user-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useViewingUserMxid: vi.fn(() => "@viewer:example.com"),
    useViewingUserId: vi.fn(() => "user-1"),
  };
});

const IDENTITIES_BY_KEY = new Map<string, Identity>();

vi.mock("@/state/identities-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useIdentities: vi.fn(() => ({
      identities: [],
      byKey: IDENTITIES_BY_KEY,
      loaded: true,
      refresh: vi.fn(),
    })),
    buildIdentityHostsFromFleet: vi.fn(() => ({})),
  };
});

// Session working store — silently satisfy AgentBadgeWithMeter transitive reads.
vi.mock("@/state/session-working-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useSessionIsWorking: vi.fn(() => false),
    useSessionIsWorkingRaw: vi.fn(() => "idle"),
    useSessionIsCondensing: vi.fn(() => false),
  };
});

// Adapter mock — the relay-source tests drive PrettyView by controlling the
// adapter's return shape directly. This lets us test the wire-up without
// needing a real WebSocket or the full port at unit-test time.
type AdapterState = {
  messages: Array<Record<string, unknown>>;
  participants: {
    humans: Array<{ mxid: string; displayName: string; userId: string }>;
    agents: Array<{ mxid: string; identityKey: string }>;
  } | null;
  sendMessage: (b: string, m: string) => Promise<boolean>;
  sendFiles?: (files: File[], caption: string) => Promise<void>;
  error: string | null;
  isReady: boolean;
};
const adapterMock = vi.fn<() => AdapterState>();
const sendMessageSpy = vi.fn(async (_b: string, _m: string) => true);

vi.mock("./sources/use-chat-surface-adapter", () => ({
  useChatSurfaceAdapter: (..._args: unknown[]): AdapterState => adapterMock(),
}));

const filesApi = vi.hoisted(() => ({
  getRelayRoomFileStatus: vi.fn(async () => "ok"),
  getRelayRoomUploadLimit: vi.fn(async () => 1000),
}));
vi.mock("@/api/relay-room-files-api", () => filesApi);

import { PrettyView } from "./PrettyView";
import { buildRoomFileUrl } from "./room-file";

const ROOM = "!room:x";
const sendFilesSpy = vi.fn(async (_f: File[], _c: string) => {});

function state(messages: Array<Record<string, unknown>> = []): AdapterState {
  return {
    messages,
    participants: { humans: [], agents: [] },
    sendMessage: sendMessageSpy,
    sendFiles: sendFilesSpy,
    error: null,
    isReady: true,
  };
}

function mount() {
  return render(
    <PrettyView
      source={{ kind: "relay", roomId: ROOM, roomTitle: "Plans" }}
      hostId={0}
      tmuxSession=""
      isVisible={true}
      onSend={() => true}
    />,
  );
}

const roomFile = (eventId: string, name: string) => ({
  roomId: ROOM,
  eventId,
  name,
  size: 4,
  mimetype: "text/plain",
  url: buildRoomFileUrl(ROOM, eventId, name),
});

describe("relay room files in the conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendFilesSpy.mockClear();
    vi.stubGlobal("ResizeObserver", vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("someone's file and the user's own file both show as file chips", () => {
    adapterMock.mockReturnValue(
      state([
        {
          type: "relay_inbound",
          room: ROOM,
          sender: "@finch:x",
          matrixEventId: "$in",
          body: "plan.txt",
          raw: "plan.txt",
          eventId: "$in",
          ts: 1,
          roomFile: roomFile("$in", "plan.txt"),
        },
        { type: "message", role: "user", content: "mine.txt", eventId: "$own", ts: 2, roomFile: roomFile("$own", "mine.txt") },
      ]),
    );
    const { getByText } = mount();
    expect(getByText("plan.txt").closest("a")?.getAttribute("href")).toContain("/file/.relay-room/");
    expect(getByText("mine.txt").closest("a")?.getAttribute("href")).toContain(encodeURIComponent("$own"));
  });

  it("paperclip → staged chip → Send hands the files and text to the room", async () => {
    adapterMock.mockReturnValue(state());
    const { container } = mount();
    expect(container.querySelector('button[aria-label="Attach file"]')).not.toBeNull();
    const input = container.querySelector('[data-testid="compose-file-picker"]') as HTMLInputElement;
    const f = new File(["data"], "notes.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [f] } });
    });
    await waitFor(() => expect(container.querySelector('[data-testid="attachment-chip"]')).not.toBeNull());
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "see attached" } });
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(sendFilesSpy).toHaveBeenCalled());
    const [files, caption] = sendFilesSpy.mock.calls[0];
    expect(files.map((x) => x.name)).toEqual(["notes.txt"]);
    expect(caption).toBe("see attached");
    await waitFor(() => expect(container.querySelector('[data-testid="attachment-chip"]')).toBeNull());
  });

  it("a file over the room's limit holds Send until it's removed", async () => {
    adapterMock.mockReturnValue(state());
    const { container } = mount();
    const input = container.querySelector('[data-testid="compose-file-picker"]') as HTMLInputElement;
    const big = new File(["x".repeat(2000)], "big.bin");
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="attachment-chip"]')?.getAttribute("data-status")).toBe("error"),
    );
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(container.querySelector('button[aria-label="Remove attachment big.bin"]')!);
    await waitFor(() => expect(container.querySelector('[data-testid="attachment-chip"]')).toBeNull());
    expect(sendFilesSpy).not.toHaveBeenCalled();
  });
});
