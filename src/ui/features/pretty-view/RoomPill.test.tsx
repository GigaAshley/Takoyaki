/**
 * RoomPill — an open relay room's handle: faces + name, hover with the
 * members, ⋯ / right-click → the room menu, drag → pane handle (desktop
 * only), and a tap that does nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/state/identities-store", () => ({
  useIdentities: vi.fn(() => ({ identities: [], byKey: new Map(), byHostKey: new Map(), loaded: true, refresh: vi.fn() })),
}));

import { RoomPill } from "./RoomPill";
import { parseBadgePayload, BADGE_MIME } from "@/shell/badge-drag";

function setMobileViewport(isMobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: isMobile ? 500 : 1280 });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function makeDataTransferStub() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    clearData: () => store.clear(),
    effectAllowed: "none" as string,
    get types() {
      return Array.from(store.keys());
    },
  };
}

const ROOM = "!room:hs";
const FACES = [
  { mxid: "@zoey:hs", kind: "human" as const, name: "Zoey", userId: "u-z", avatarPath: null },
  { mxid: "@vector:hs", kind: "agent" as const, name: "vector" },
];

function renderPill(overrides: Partial<React.ComponentProps<typeof RoomPill>> = {}) {
  const menuItems = [
    { label: "Rename…", onClick: vi.fn() },
    { label: "Close", onClick: vi.fn() },
  ];
  render(
    <RoomPill
      roomId={ROOM}
      title="garden-room"
      faces={FACES}
      othersCount={2}
      memberNames={["Zoey", "vector"]}
      tabId="tab-room"
      menuItems={menuItems}
      {...overrides}
    />,
  );
  return { menuItems };
}

beforeEach(() => setMobileViewport(false));

describe("RoomPill", () => {
  it("shows the room's faces and name, and hovers with the full name and members", () => {
    renderPill();
    expect(screen.getByTestId("pv-room-pill-label").textContent).toBe("garden-room");
    expect(screen.getByTestId("pv-room-pill-faces").querySelectorAll('[data-testid="pv-room-face"]').length).toBe(2);
    expect(screen.getByTestId("pv-room-pill").getAttribute("title")).toBe("garden-room · Zoey, vector");
  });

  it("never shows a room id as its name", () => {
    renderPill({ title: null });
    expect(screen.getByTestId("pv-room-pill-label").textContent).toBe("Relay room");
  });

  it("has no memory pie and no round buttons", () => {
    renderPill();
    expect(screen.queryByTestId("pv-task-pill-memory")).toBeNull();
    expect(screen.queryByTestId("pv-task-pill-side")).toBeNull();
  });

  it("a tap does nothing", async () => {
    const user = userEvent.setup();
    const { menuItems } = renderPill();
    await user.click(screen.getByTestId("pv-room-pill-label"));
    expect(screen.queryByRole("menuitem")).toBeNull();
    for (const i of menuItems) expect(i.onClick).not.toHaveBeenCalled();
  });

  it("⋯ opens the room menu; choosing an item runs it", async () => {
    const user = userEvent.setup();
    const { menuItems } = renderPill();
    await user.click(screen.getByTestId("pv-room-pill-kebab-trigger"));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(menuItems[1].onClick).toHaveBeenCalledTimes(1);
  });

  it("right-click opens the same menu", async () => {
    renderPill();
    fireEvent.contextMenu(screen.getByTestId("pv-room-pill"), { clientX: 100, clientY: 40 });
    expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeTruthy();
  });

  it("dragging it carries this room's pane — what the drop lane and the sidebar read", () => {
    renderPill();
    const pill = screen.getByTestId("pv-room-pill");
    expect(pill.getAttribute("draggable")).toBe("true");
    const dt = makeDataTransferStub();
    fireEvent.dragStart(pill, { dataTransfer: dt });
    expect(dt.getData("text/plain")).toBe("tab-room");
    expect(parseBadgePayload(dt.getData(BADGE_MIME))).toEqual({
      tabId: "tab-room",
      hostId: null,
      identityKey: null,
      sessionKind: "relay-room",
      targetTmuxSession: null,
      relayRoomId: ROOM,
    });
  });

  it("a drag starting on the ⋯ is cancelled", () => {
    renderPill();
    const ev = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => {
      screen.getByTestId("pv-room-pill-kebab-trigger").dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("not draggable on a phone, but the ⋯ is still there", () => {
    setMobileViewport(true);
    renderPill();
    expect(screen.getByTestId("pv-room-pill").getAttribute("draggable")).toBe("false");
    expect(screen.getByTestId("pv-room-pill-kebab-trigger")).toBeTruthy();
  });
});
