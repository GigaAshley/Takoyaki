/**
 * App bar menu — the ⋯ button + right-click on an open app pane's bar, the
 * app-pane counterpart of the IdentityBadge menu. Covers item set + order on
 * desktop and mobile, Close, Move to new tab (incl. popup blocked), the
 * shared Archive flow closing panes via onArchiveApp, right-click opening the
 * same menu, and a kebab click never selecting the pane.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mobileState = { isMobile: false };
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.isMobile,
}));

vi.mock("@/api/apps-archive-api", () => ({
  archiveApp: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/api/apps-move-api", () => ({
  requestAppMove: vi.fn().mockResolvedValue({ ok: true }),
}));

import { AppPane } from "./AppPane";
import { archiveApp } from "@/api/apps-archive-api";
import { requestAppMove } from "@/api/apps-move-api";
import { publishAppSnapshot, __resetForTest as resetAppTiles, useAppTiles } from "@/state/app-tiles-store";
import type { AppState } from "@/api/fleet-status-types";
import { autoAnswerKitDialogs, __resetKitDialogsForTests } from "@/components/kit";

async function openKebab(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector(
    '[data-testid="app-pane-kebab-trigger"]',
  ) as HTMLElement | null;
  if (!trigger) throw new Error("app bar kebab trigger not found");
  await userEvent.setup().click(trigger);
  return screen.getByRole("menu");
}

function itemLabels(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function clickItem(menu: HTMLElement, label: string) {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === label,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`menu item ${label} not found`);
  fireEvent.click(item);
}

beforeEach(() => {
  mobileState.isMobile = false;
});

afterEach(() => {
  __resetKitDialogsForTests();
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(archiveApp).mockClear();
});

describe("AppPane bar menu", () => {
  it("desktop: kebab lists Move to new tab, Open standalone, Rename…, Close, Archive", async () => {
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    const menu = await openKebab(container);
    expect(itemLabels(menu)).toEqual([
      "Move to new tab",
      "Open standalone",
      "Rename…",
      "Close",
      "Archive",
    ]);
  });

  it("the ⋯ button and its menu take the kit look", async () => {
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    const trigger = container.querySelector('[data-testid="app-pane-kebab-trigger"]') as HTMLElement;
    expect(trigger.className).toContain("k-icon-btn");
    expect(trigger.querySelector("svg.lucide-ellipsis, svg.lucide-more-horizontal")).not.toBeNull();
    const menu = await openKebab(container);
    expect(menu.className).toContain("k-menu");
  });

  it("mobile: no Move to new tab or Close", async () => {
    mobileState.isMobile = true;
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    const menu = await openKebab(container);
    expect(itemLabels(menu)).toEqual(["Open standalone", "Rename…", "Archive"]);
  });

  it("Close closes this pane", async () => {
    const onCloseTab = vi.fn();
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={onCloseTab} />,
    );
    clickItem(await openKebab(container), "Close");
    expect(onCloseTab).toHaveBeenCalledWith("t1");
  });

  it("Move to new tab opens an app workspace window and closes this pane", async () => {
    const onCloseTab = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={onCloseTab} />,
    );
    clickItem(await openKebab(container), "Move to new tab");
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0]).startsWith("#")).toBe(true);
    expect(open.mock.calls[0][1]).toBe("_blank");
    expect(onCloseTab).toHaveBeenCalledWith("t1");
  });

  it("Move to new tab keeps the pane when the popup is blocked", async () => {
    const onCloseTab = vi.fn();
    vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={onCloseTab} />,
    );
    clickItem(await openKebab(container), "Move to new tab");
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("Open standalone opens the app's own URL with the tabnabbing guard", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<AppPane hostId={1} slug="todo" tabId="t1" isVisible />);
    clickItem(await openKebab(container), "Open standalone");
    expect(open).toHaveBeenCalledWith("/apps/1/todo", "_blank", "noopener,noreferrer");
  });

  it("Archive (both confirms accepted) closes the app's panes and archives it", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: true });
    const onArchiveApp = vi.fn();
    const { container } = render(
      <AppPane
        hostId={1}
        slug="todo"
        tabId="t1"
        isVisible
        label="Todo"
        onArchiveApp={onArchiveApp}
      />,
    );
    clickItem(await openKebab(container), "Archive");
    await vi.waitFor(() => expect(archiveApp).toHaveBeenCalledWith(1, "todo"));
    expect(onArchiveApp).toHaveBeenCalledWith(1, "todo", "Todo");
    expect(dialogs.calls.filter((c) => c.kind === "confirm")).toHaveLength(2);
  });

  it("Archive declined does nothing", async () => {
    const dialogs = autoAnswerKitDialogs({ confirm: false });
    const onArchiveApp = vi.fn();
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onArchiveApp={onArchiveApp} />,
    );
    clickItem(await openKebab(container), "Archive");
    await vi.waitFor(() => expect(dialogs.calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(onArchiveApp).not.toHaveBeenCalled();
    expect(archiveApp).not.toHaveBeenCalled();
  });

  it("right-click on the bar opens the same menu", () => {
    const { getByTestId } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    fireEvent.contextMenu(getByTestId("app-pane-bar"), { clientX: 50, clientY: 10 });
    expect(itemLabels(screen.getByRole("menu"))).toEqual([
      "Move to new tab",
      "Open standalone",
      "Rename…",
      "Close",
      "Archive",
    ]);
  });

  it("clicking the kebab does not select the pane", async () => {
    const onSelectPane = vi.fn();
    const { container } = render(
      <AppPane hostId={1} slug="todo" tabId="t1" isVisible onSelectPane={onSelectPane} />,
    );
    await openKebab(container);
    expect(onSelectPane).not.toHaveBeenCalled();
  });
});


// A conversation app (goes with its conversation) and a project app (goes with
// its project) have no Rename… / Archive of their own; every app known to the
// store has Move to (project-scoped apps).
describe("AppPane bar menu — Move to", () => {
  const convoApp: AppState = {
    hostId: "1",
    slug: "tally",
    title: "Tally",
    description: "",
    port: 9505,
    hasIcon: false,
    createdAtMs: 0,
    isHealthy: true,
    healthMessage: null,
    owner: "alpha",
  };
  const projectApp: AppState = { ...convoApp, slug: "beds", title: "Beds", owner: null, project: "garden" };
  const sidebarApp: AppState = { ...convoApp, slug: "side", title: "Side", owner: null, project: null };

  beforeEach(() => {
    resetAppTiles();
    publishAppSnapshot([convoApp, projectApp, sidebarApp]);
    vi.mocked(requestAppMove).mockClear();
  });

  afterEach(() => resetAppTiles());

  it("conversation app: Move to new tab, Open standalone, Move to, Close — no Rename or Archive", async () => {
    const { container } = render(
      <AppPane hostId={1} slug="tally" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    expect(itemLabels(await openKebab(container))).toEqual([
      "Move to new tab",
      "Open standalone",
      "Move to",
      "Close",
    ]);
  });

  it("project app: Rename… but no Share or Archive", async () => {
    const { container } = render(
      <AppPane hostId={1} slug="beds" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    expect(itemLabels(await openKebab(container))).toEqual([
      "Move to new tab",
      "Open standalone",
      "Rename…",
      "Move to",
      "Close",
    ]);
  });

  it("sidebar app: Move to sits between Rename… and Close", async () => {
    const { container } = render(
      <AppPane hostId={1} slug="side" tabId="t1" isVisible onCloseTab={vi.fn()} />,
    );
    expect(itemLabels(await openKebab(container))).toEqual([
      "Move to new tab",
      "Open standalone",
      "Rename…",
      "Move to",
      "Close",
      "Archive",
    ]);
  });

  it("Move to → Sidebar asks the machine and shows the app in the sidebar at once", async () => {
    let tiles: AppState[] = [];
    function Probe() {
      tiles = useAppTiles();
      return null;
    }
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Probe />
        <AppPane hostId={1} slug="tally" tabId="t1" isVisible onCloseTab={vi.fn()} />
      </>,
    );
    const menu = await openKebab(container);
    await user.click(menu.querySelector('[data-testid="app-menu-item-move-to"]') as HTMLElement);
    fireEvent.click(screen.getByTestId("app-menu-move-to-sidebar"));
    expect(requestAppMove).toHaveBeenCalledWith(1, "tally", { to: "sidebar" }, expect.any(Function));
    await vi.waitFor(() => expect(tiles.find((t) => t.slug === "tally")?.owner).toBeNull());
  });

  it("a refused move is reported and the app goes back", async () => {
    vi.mocked(requestAppMove).mockRejectedValueOnce(new Error("Host unreachable"));
    const dialogs = autoAnswerKitDialogs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let tiles: AppState[] = [];
    function Probe() {
      tiles = useAppTiles();
      return null;
    }
    const user = userEvent.setup();
    const { container } = render(
      <>
        <Probe />
        <AppPane hostId={1} slug="tally" tabId="t1" isVisible onCloseTab={vi.fn()} />
      </>,
    );
    const menu = await openKebab(container);
    await user.click(menu.querySelector('[data-testid="app-menu-item-move-to"]') as HTMLElement);
    fireEvent.click(screen.getByTestId("app-menu-move-to-sidebar"));
    await vi.waitFor(() => expect(dialogs.calls.some((c) => c.kind === "alert")).toBe(true));
    expect(String(dialogs.calls.find((c) => c.kind === "alert")?.opts.body)).toContain("Host unreachable");
    expect(tiles.find((t) => t.slug === "tally")?.owner).toBe("alpha");
  });
});
