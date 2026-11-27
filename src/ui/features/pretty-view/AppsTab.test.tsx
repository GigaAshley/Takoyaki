/**
 * An Apps tab (identity modal: the conversation's apps; project modal: the
 * project's apps) lists the apps; a row click closes the modal and opens the
 * app; each row's ⋮ holds one item, Move to — the sidebar or a project.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppsTab, conversationAppsFor, projectAppsFor } from "./AppsTab";
import { OPEN_APP_EVENT, type OpenAppDetail } from "../apps/app-link";
import type { AppState } from "@/api/fleet-status-types";

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock("@/api/apps-move-api", () => ({
  requestAppMove: vi.fn().mockResolvedValue({ ok: true }),
}));
import { requestAppMove } from "@/api/apps-move-api";

vi.mock("@/state/conversation-store", () => ({
  useProjects: () => [
    { slug: "garden", displayName: "Garden", hostId: "6", hostname: "h", archived: false, parent: null },
    { slug: "beds", displayName: "Beds", hostId: "6", hostname: "h", archived: false, parent: "garden" },
    { slug: "far", displayName: "Far", hostId: "7", hostname: "h7", archived: false, parent: null },
  ],
}));

const base: AppState = {
  hostId: "6",
  slug: "tally",
  title: "Tally",
  description: "counts things",
  port: 9505,
  hasIcon: false,
  createdAtMs: 0,
  isHealthy: true,
  healthMessage: null,
  owner: "alpha",
};

beforeEach(() => vi.mocked(requestAppMove).mockClear());
afterEach(() => cleanup());

describe("conversationAppsFor / projectAppsFor", () => {
  it("keeps only this identity's apps on this host", () => {
    const apps = [
      base,
      { ...base, slug: "side", owner: null },
      { ...base, slug: "other", owner: "beta" },
      { ...base, slug: "elsewhere", hostId: "7" },
    ];
    expect(conversationAppsFor(apps, 6, "alpha").map((a) => a.slug)).toEqual(["tally"]);
    expect(conversationAppsFor(apps, 6, "ALPHA").map((a) => a.slug)).toEqual(["tally"]);
  });

  it("keeps only this project's apps on this host", () => {
    const apps = [
      { ...base, slug: "p1", owner: null, project: "garden" },
      { ...base, slug: "p2", owner: null, project: "beds" },
      { ...base, slug: "p3", owner: null, project: "garden", hostId: "7" },
      { ...base, slug: "side", owner: null, project: null },
    ];
    expect(projectAppsFor(apps, 6, "garden").map((a) => a.slug)).toEqual(["p1"]);
  });
});

describe("AppsTab", () => {
  it("row click closes the modal and opens the app", () => {
    const onClose = vi.fn();
    const seen: OpenAppDetail[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent<OpenAppDetail>).detail);
    window.addEventListener(OPEN_APP_EVENT, h);
    try {
      render(<AppsTab apps={[base]} onClose={onClose} />);
      expect(screen.getByText("counts things")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Tally" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ hostId: 6, slug: "tally", title: "Tally" }]);
    } finally {
      window.removeEventListener(OPEN_APP_EVENT, h);
    }
  });

  it("the row menu holds only Move to: the sidebar and this machine's projects, indented", async () => {
    const user = userEvent.setup();
    render(<AppsTab apps={[base]} onClose={vi.fn()} />);
    await user.click(screen.getByTestId("identity-apps-row-kebab"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim())).toEqual(["Move to"]);
    await user.click(within(menu).getByTestId("app-menu-item-move-to"));
    expect(screen.getByTestId("app-menu-move-to-sidebar")).toBeTruthy();
    expect(screen.getByTestId("app-menu-move-to-project-garden")).toBeTruthy();
    expect(screen.getByTestId("app-menu-move-to-project-beds")).toBeTruthy();
    expect(screen.queryByTestId("app-menu-move-to-project-far")).toBeNull();
    fireEvent.click(screen.getByTestId("app-menu-move-to-project-beds"));
    expect(requestAppMove).toHaveBeenCalledWith(6, "tally", { to: "project", project: "beds" }, expect.any(Function));
  });

  it("picking where a project app already is does nothing; the sidebar moves it", async () => {
    const user = userEvent.setup();
    render(<AppsTab apps={[{ ...base, owner: null, project: "garden" }]} onClose={vi.fn()} testId="project-apps-tab" />);
    expect(screen.getByTestId("project-apps-tab")).toBeTruthy();
    await user.click(screen.getByTestId("identity-apps-row-kebab"));
    await user.click(within(screen.getByRole("menu")).getByTestId("app-menu-item-move-to"));
    fireEvent.click(screen.getByTestId("app-menu-move-to-project-garden"));
    expect(requestAppMove).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("identity-apps-row-kebab"));
    await user.click(within(screen.getByRole("menu")).getByTestId("app-menu-item-move-to"));
    fireEvent.click(screen.getByTestId("app-menu-move-to-sidebar"));
    expect(requestAppMove).toHaveBeenCalledWith(6, "tally", { to: "sidebar" }, expect.any(Function));
  });
});
