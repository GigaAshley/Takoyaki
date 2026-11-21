// The room pill's menu: the room's sidebar actions plus Move to new tab and
// Close (desktop only), and Move to filing the room (Pinned / a project).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const pinned = new Set<string>();
let assigned: string | null = null;
vi.mock("@/state/conversation-store", () => ({
  usePinnedIds: () => pinned,
  useProjects: () => [
    { slug: "plans", displayName: "Plans", hostId: "1", archived: false },
    { slug: "old", displayName: "Old", hostId: "1", archived: true },
  ],
  useRoomProjectSlug: () => assigned,
  useHostTree: () => null,
  pinConversation: vi.fn((id: string) => pinned.add(id)),
  unpinConversation: vi.fn((id: string) => pinned.delete(id)),
  patchRoomProjectAssignment: vi.fn(() => () => {}),
}));
vi.mock("@/state/project-tree", () => ({
  orderProjectsAsTree: (ps: Array<{ slug: string }>) => ps.map((project) => ({ project, depth: 0 })),
}));
vi.mock("@/state/viewing-user-store", () => ({ useViewingUserMxid: () => "@ashley:hs" }));
vi.mock("@/api/session-project-api", () => ({ setRelayRoomProject: vi.fn(() => Promise.resolve()) }));
vi.mock("@/features/pretty-conversations/relay-room-row-actions", () => ({
  confirmAndLeaveRelayRoom: vi.fn(),
  promptAndRenameRelayRoom: vi.fn(),
}));
vi.mock("@/features/pretty-conversations/CreateProjectModal", () => ({ CreateProjectModal: () => null }));
let mobile = false;
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));

import { useRelayRoomPaneMenu } from "./relay-room-pane-menu";
import { setRelayRoomProject } from "@/api/session-project-api";
import { confirmAndLeaveRelayRoom, promptAndRenameRelayRoom } from "@/features/pretty-conversations/relay-room-row-actions";
import { pinConversation, unpinConversation } from "@/state/conversation-store";

const ROOM = "!room:hs";

function menu(onCloseTab = vi.fn()) {
  const { result } = renderHook(() =>
    useRelayRoomPaneMenu({ tabId: "tab-r", roomId: ROOM, title: "Plans room", onCloseTab }),
  );
  return { items: result.current.items, onCloseTab };
}

beforeEach(() => {
  pinned.clear();
  assigned = null;
  mobile = false;
  vi.clearAllMocks();
});

describe("room pill menu", () => {
  it("desktop: Move to new tab, Rename…, Move to, Leave, Close", () => {
    expect(menu().items.map((i) => i.label)).toEqual(["Move to new tab", "Rename…", "Move to", "Leave", "Close"]);
  });

  it("phone: no Move to new tab and no Close", () => {
    mobile = true;
    expect(menu().items.map((i) => i.label)).toEqual(["Rename…", "Move to", "Leave"]);
  });

  it("Close closes this pane; Rename… and Leave are the room's own actions", () => {
    const { items, onCloseTab } = menu();
    items.find((i) => i.label === "Close")!.onClick!();
    expect(onCloseTab).toHaveBeenCalledWith("tab-r");
    items.find((i) => i.label === "Rename…")!.onClick!();
    expect(promptAndRenameRelayRoom).toHaveBeenCalledWith({ roomId: ROOM, currentTitle: "Plans room" });
    const leave = items.find((i) => i.label === "Leave")!;
    expect(leave.danger).toBe(true);
    leave.onClick!();
    expect(confirmAndLeaveRelayRoom).toHaveBeenCalledWith({ roomId: ROOM, title: "Plans room" });
  });

  it("Move to offers the live projects and New project… (no Pinned, as on the room's sidebar menu) and files the room", () => {
    const moveTo = menu().items.find((i) => i.label === "Move to")!;
    const sub = moveTo.submenu!;
    expect(sub.map((s) => s.label)).toEqual(["Plans", "New project…"]);
    act(() => sub.find((s) => s.label === "Plans")!.onClick!());
    expect(setRelayRoomProject).toHaveBeenCalledWith(ROOM, "@ashley:hs", "plans");
    expect(pinConversation).not.toHaveBeenCalled();
  });

  it("a leftover local pin is dropped when the room is moved, so it lands where it was put", () => {
    pinned.add("tab-r");
    assigned = "plans";
    const sub = menu().items.find((i) => i.label === "Move to")!.submenu!;
    act(() => sub.find((s) => s.label === "Remove from project")!.onClick!());
    expect(unpinConversation).toHaveBeenCalledWith("tab-r");
  });

  it("never names the room by its id before its name is known", () => {
    const { result } = renderHook(() =>
      useRelayRoomPaneMenu({ tabId: "tab-r", roomId: ROOM, title: null, onCloseTab: vi.fn() }),
    );
    result.current.items.find((i) => i.label === "Leave")!.onClick!();
    expect(confirmAndLeaveRelayRoom).toHaveBeenCalledWith({ roomId: ROOM, title: "this room" });
  });

  it("a room in a project shows the check there and offers Remove from project", () => {
    assigned = "plans";
    const sub = menu().items.find((i) => i.label === "Move to")!.submenu!;
    expect(sub.find((s) => s.label === "Plans")!.checked).toBe(true);
    const remove = sub.find((s) => s.label === "Remove from project")!;
    act(() => remove.onClick!());
    expect(setRelayRoomProject).toHaveBeenCalledWith(ROOM, "@ashley:hs", null);
  });
});
