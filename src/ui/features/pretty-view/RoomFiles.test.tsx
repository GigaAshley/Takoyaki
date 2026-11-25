// Files in relay rooms, on the app side: the room file address, the chip
// (including "can't be opened"), staging with the room's upload limit, and
// the room composer's paperclip + held Send.

import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, renderHook, act } from "@testing-library/react";

vi.mock("@/api/compose-drafts-api", () => ({
  getComposeDraft: vi.fn().mockResolvedValue({ body: "", queueSlots: [] }),
  putComposeDraft: vi.fn().mockResolvedValue(undefined),
  flushComposeDraftKeepalive: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getRelayRoomFileStatus: vi.fn(),
  getRelayRoomUploadLimit: vi.fn(),
}));
vi.mock("@/api/relay-room-files-api", () => api);

import { roomFileFromContent, buildRoomFileUrl } from "./room-file";
import { parseSkynetFileUrl } from "./file-url";
import { RoomFileChip, __resetRoomFileStatusCacheForTest } from "./RoomFileChip";
import {
  useRelayRoomUploads,
  __resetRelayRoomUploadLimitsForTest,
  formatLimit,
} from "./use-relay-room-uploads";
import { ComposeBox, type ComposeBoxProps } from "./ComposeBox";

const ROOM = "!abc:hs.example";

beforeEach(() => {
  api.getRelayRoomFileStatus.mockReset().mockResolvedValue("ok");
  api.getRelayRoomUploadLimit.mockReset().mockResolvedValue(50 * 1024 * 1024);
  __resetRoomFileStatusCacheForTest();
  __resetRelayRoomUploadLimitsForTest();
});

describe("room file address", () => {
  it("is an ordinary file address under the room host, naming room and post", () => {
    const url = buildRoomFileUrl(ROOM, "$ev1:hs", "my notes.txt");
    expect(parseSkynetFileUrl(url)).toEqual({
      host: ".relay-room",
      path: `/${encodeURIComponent(ROOM)}/${encodeURIComponent("$ev1:hs")}/my notes.txt`,
    });
  });

  it("a slash in a file's name can't add path segments", () => {
    const url = buildRoomFileUrl(ROOM, "$ev1", "a/b.txt");
    expect(parseSkynetFileUrl(url)?.path).toBe(`/${encodeURIComponent(ROOM)}/%24ev1/a_b.txt`);
  });

  it("reads name, size and type from a file post", () => {
    const f = roomFileFromContent(
      { msgtype: "m.video", body: "clip.mp4", url: "mxc://hs/v", info: { size: 99, mimetype: "video/mp4" } },
      ROOM,
      "$v",
    );
    expect(f).toMatchObject({ name: "clip.mp4", size: 99, mimetype: "video/mp4" });
    expect(f?.url).not.toBeNull();
    expect(roomFileFromContent({ msgtype: "m.text", body: "hi" }, ROOM, "$t")).toBeNull();
  });

  it("a post's own caption (body beside a separate file name) is kept", () => {
    const f = roomFileFromContent(
      { msgtype: "m.image", filename: "cat.png", body: "look at this", url: "mxc://hs/c" },
      ROOM,
      "$c",
    );
    expect(f?.name).toBe("cat.png");
    expect(f?.caption).toBe("look at this");
    expect(roomFileFromContent({ msgtype: "m.image", body: "cat.png", url: "mxc://hs/c" }, ROOM, "$c")?.caption).toBeUndefined();
  });
});

describe("RoomFileChip", () => {
  const ref = (over = {}) => ({
    roomId: ROOM,
    eventId: "$e",
    name: "report.pdf",
    size: 10,
    mimetype: "application/pdf",
    url: buildRoomFileUrl(ROOM, "$e", "report.pdf"),
    ...over,
  });

  it("an openable file is an ordinary file chip that opens the file window", async () => {
    const onOpenEditor = vi.fn();
    render(<RoomFileChip file={ref()} onOpenEditor={onOpenEditor} />);
    fireEvent.click(screen.getByText("report.pdf"));
    expect(onOpenEditor).toHaveBeenCalledWith(
      expect.objectContaining({ messageEventId: "$e", filename: "report.pdf" }),
    );
    await waitFor(() => expect(api.getRelayRoomFileStatus).toHaveBeenCalledWith(ROOM, "$e"));
    expect(screen.queryByTestId("room-file-unavailable")).toBeNull();
  });

  it("an encrypted file shows its name with a note, never vanishes", () => {
    render(<RoomFileChip file={ref({ url: null, unavailable: "encrypted" })} />);
    const chip = screen.getByTestId("room-file-unavailable");
    expect(chip).toHaveTextContent("report.pdf");
    expect(chip).toHaveTextContent("can't be opened");
    expect(api.getRelayRoomFileStatus).not.toHaveBeenCalled();
  });

  it("a file the chat server no longer has turns into the can't-be-opened chip", async () => {
    api.getRelayRoomFileStatus.mockResolvedValue("not_found");
    render(<RoomFileChip file={ref()} />);
    expect(await screen.findByTestId("room-file-unavailable")).toHaveTextContent("No longer available");
  });

  it("with a fallback, a file that can't be opened shows the fallback instead of the note", async () => {
    api.getRelayRoomFileStatus.mockResolvedValue("not_found");
    render(<RoomFileChip file={ref()} fallback={<span>📎 report.pdf</span>} />);
    expect(await screen.findByText("📎 report.pdf")).toBeInTheDocument();
    expect(screen.queryByTestId("room-file-unavailable")).toBeNull();
  });

  it("shows a post's own caption under the chip", () => {
    render(<RoomFileChip file={ref({ caption: "the Q3 numbers" })} />);
    expect(screen.getByTestId("room-file-caption")).toHaveTextContent("the Q3 numbers");
  });

  it("checks only a few files at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    api.getRelayRoomFileStatus.mockImplementation(async () => {
      await gate;
      return "ok";
    });
    render(
      <>
        {[1, 2, 3, 4, 5].map((i) => (
          <RoomFileChip key={i} file={ref({ eventId: `$e${i}` })} />
        ))}
      </>,
    );
    await waitFor(() => expect(api.getRelayRoomFileStatus).toHaveBeenCalledTimes(3));
    release();
    await waitFor(() => expect(api.getRelayRoomFileStatus).toHaveBeenCalledTimes(5));
  });

  it("a check that couldn't run leaves the file openable", async () => {
    api.getRelayRoomFileStatus.mockResolvedValue("unknown");
    render(<RoomFileChip file={ref()} />);
    await waitFor(() => expect(api.getRelayRoomFileStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("room-file-unavailable")).toBeNull();
  });
});

describe("staging files in a room", () => {
  const big = () => {
    const f = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(f, "size", { value: 60 * 1024 * 1024 });
    return f;
  };

  it("a file over the room's limit is caught at attach, naming the limit", async () => {
    const { result } = renderHook(() => useRelayRoomUploads(ROOM));
    await waitFor(() => expect(api.getRelayRoomUploadLimit).toHaveBeenCalledWith(ROOM));
    act(() => result.current.stageAttachments("primary", [big(), new File(["ok"], "ok.txt")]));
    await waitFor(() => expect(result.current.stagedAttachments[0].status).toBe("error"));
    expect(result.current.stagedAttachments[0].error).toBe(
      "Too big to send to this room — the limit is 50 MB",
    );
    expect(result.current.stagedAttachments[1].status).toBe("staged");
    act(() => result.current.removeAttachment(result.current.stagedAttachments[0].tempId));
    expect(result.current.stagedAttachments.map((a) => a.file.name)).toEqual(["ok.txt"]);
  });

  it("a room whose server names no limit takes any size", async () => {
    api.getRelayRoomUploadLimit.mockResolvedValue(null);
    const { result } = renderHook(() => useRelayRoomUploads(ROOM));
    act(() => result.current.stageAttachments("primary", [big()]));
    await waitFor(() => expect(api.getRelayRoomUploadLimit).toHaveBeenCalled());
    expect(result.current.stagedAttachments[0].status).toBe("staged");
  });

  it("limits read in plain sizes", () => {
    expect(formatLimit(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("a room's composer", () => {
  const props = (over: Partial<ComposeBoxProps> = {}): ComposeBoxProps => ({
    onSend: vi.fn(() => true),
    hostId: 1,
    tmuxSession: "s1",
    showPaperclip: true,
    canSend: true,
    mode: "relay",
    ...over,
  });
  const chip = (status: "staged" | "error") => ({
    tempId: status,
    file: new File(["a"], `${status}.txt`),
    status,
    bytesUploaded: 0,
    error: status === "error" ? "Too big to send to this room — the limit is 50 MB" : null,
  });

  it("shows the paperclip when the room takes files", () => {
    const { container, rerender } = render(<ComposeBox {...props({ relayFiles: true })} />);
    expect(container.querySelector('button[aria-label="Attach file"]')).not.toBeNull();
    rerender(<ComposeBox {...props({ relayFiles: false })} />);
    expect(container.querySelector('button[aria-label="Attach file"]')).toBeNull();
  });

  it("holds Send while a staged file can't be sent", () => {
    const onSendWithAttachments = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(
      <ComposeBox
        {...props({ relayFiles: true, stagedAttachments: [chip("staged"), chip("error")], onSendWithAttachments })}
      />,
    );
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(true);
    const ta = container.querySelector("textarea")!;
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSendWithAttachments).not.toHaveBeenCalled();
  });

  it("sends staged files once nothing is held", async () => {
    const onSendWithAttachments = vi.fn(async () => ({ ok: true as const }));
    const { container } = render(
      <ComposeBox {...props({ relayFiles: true, stagedAttachments: [chip("staged")], onSendWithAttachments })} />,
    );
    const send = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onSendWithAttachments).toHaveBeenCalled());
  });
});
