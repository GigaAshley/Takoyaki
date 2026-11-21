// Relay-room rows: Leave + Rename… in the row menu, and the stacked faces in
// the picture spot.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Identity } from "@/api/identities-api";
import type { RelayRoomFace } from "@/api/sessions-api";
import type { ConversationRow as ConversationRowShape } from "@/state/conversation-store";

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

let identities = new Map<string, Identity>();
vi.mock("@/state/identities-store", () => ({
  useIdentities: () => ({ byKey: identities, identities: [], loaded: true, refresh: async () => {} }),
}));
vi.mock("@/state/trapped-work-store", () => ({ useTrappedWork: () => undefined }));

const leaveMock = vi.fn();
const renameMock = vi.fn();
vi.mock("./relay-room-row-actions", () => ({
  confirmAndLeaveRelayRoom: (...a: unknown[]) => leaveMock(...a),
  promptAndRenameRelayRoom: (...a: unknown[]) => renameMock(...a),
}));

import { PrettyConversationRow } from "./PrettyConversationRow";

const AGENT: RelayRoomFace = { mxid: "@finch:hs", kind: "agent", name: "finch" };
const PERSON: RelayRoomFace = {
  mxid: "@zed_human:hs",
  kind: "human",
  name: "zed",
  userId: "u-zed",
  avatarPath: "z.webp",
};

function roomRow(over: Partial<ConversationRowShape> = {}): ConversationRowShape {
  return {
    id: "room-1",
    type: "terminal",
    label: "Launch plans",
    host: undefined,
    targetTmuxSession: null,
    kind: "relay-room",
    roomId: "!room:hs",
    roomTitle: "Launch plans",
    ...over,
  };
}

function renderRow(row: ConversationRowShape) {
  return render(
    <PrettyConversationRow
      row={row}
      selected={false}
      pinned={false}
      variant="desktop"
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
    />,
  );
}

async function openMenu(container: HTMLElement) {
  const trigger = container.querySelector('[data-testid="pv-row-kebab-trigger"]') as HTMLElement;
  await userEvent.setup().click(trigger);
  return screen.getByRole("menu");
}

beforeEach(() => {
  identities = new Map();
  leaveMock.mockReset();
  renameMock.mockReset();
});

describe("relay-room row menu", () => {
  it("offers Rename… and Leave, wired to the room", async () => {
    const { container } = renderRow(roomRow());
    const menu = await openMenu(container);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    expect(renameMock).toHaveBeenCalledWith({ roomId: "!room:hs", currentTitle: "Launch plans" });

    const menu2 = await openMenu(container);
    fireEvent.click(within(menu2).getByRole("menuitem", { name: "Leave" }));
    expect(leaveMock).toHaveBeenCalledWith({ roomId: "!room:hs", title: "Launch plans" });
  });

  it("agent rows get no Leave", async () => {
    const { container } = render(
      <PrettyConversationRow
        row={{ id: "c", type: "terminal", label: "nelly", host: undefined, targetTmuxSession: "nelly" }}
        selected={false}
        pinned={false}
        variant="desktop"
        onSelect={vi.fn()}
      />,
    );
    const menu = await openMenu(container);
    expect(within(menu).queryByRole("menuitem", { name: "Leave" })).toBeNull();
  });
});

describe("relay-room stacked faces", () => {
  it("two others + more → two stacked faces and +N", () => {
    identities.set("finch", {
      identityKey: "finch",
      displayName: "Finch",
      avatarUrl: "/identities/finch/avatar?hostId=1",
    } as Identity);
    const { container } = renderRow(roomRow({ roomFaces: [AGENT, PERSON], roomOthersCount: 4 }));
    const avatar = container.querySelector('[data-testid="pcrow-avatar"]') as HTMLElement;
    expect(avatar.className).toContain("pv-avatar--faces");
    const faces = avatar.querySelectorAll('[data-testid="pv-room-face"]');
    expect([...faces].map((f) => f.getAttribute("data-mxid"))).toEqual(["@finch:hs", "@zed_human:hs"]);
    expect(faces[0].querySelector("img")?.getAttribute("src")).toBe("/identities/finch/avatar?hostId=1");
    expect(faces[1].querySelector("img")?.getAttribute("src")).toBe("/users/u-zed/avatar?f=z.webp");
    expect(within(avatar).getByTestId("pv-room-more").textContent).toBe("+2");
  });

  it("exactly two others → no +N", () => {
    const { container } = renderRow(roomRow({ roomFaces: [AGENT, PERSON], roomOthersCount: 2 }));
    expect(container.querySelector('[data-testid="pv-room-more"]')).toBeNull();
  });

  it("one other person → just their face, filling the spot", () => {
    const { container } = renderRow(
      roomRow({ roomFaces: [{ ...PERSON, avatarPath: null }], roomOthersCount: 1 }),
    );
    const avatar = container.querySelector('[data-testid="pcrow-avatar"]') as HTMLElement;
    expect(avatar.className).not.toContain("pv-avatar--faces");
    const faces = avatar.querySelectorAll('[data-testid="pv-room-face"]');
    expect(faces).toHaveLength(1);
    // No picture → their initial.
    expect(within(avatar).getByTestId("avatar-initial").textContent).toBe("Z");
  });

  it("no faces known → the plain icon", () => {
    const { container } = renderRow(roomRow());
    expect(container.querySelector('[data-testid="pv-room-face"]')).toBeNull();
    expect(container.querySelector(".pv-avatar-fallback-icon")).not.toBeNull();
  });
});
