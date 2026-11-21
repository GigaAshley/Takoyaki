// project-scoped apps: a project app's sidebar row, and a project's section
// taking an app dragged onto it.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, createEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppState } from "@/api/fleet-status-types";

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock("@/state/conversation-store", () => ({
  useProjects: () => [
    { slug: "garden", displayName: "Garden", hostId: "6", hostname: "h", archived: false, parent: null },
    { slug: "shed", displayName: "Shed", hostId: "6", hostname: "h", archived: false, parent: null },
  ],
}));

import { ProjectAppRow } from "./ProjectAppRow";
import { PrettyProjectSectionHeader } from "./PrettyProjectSectionHeader";
import { endAppDrag, getDraggedApp, startAppDrag } from "./app-drag";

const app: AppState = {
  hostId: "6",
  slug: "beds",
  title: "Beds",
  description: "what grows where",
  port: 9505,
  hasIcon: false,
  createdAtMs: 0,
  isHealthy: true,
  healthMessage: null,
  owner: null,
  project: "garden",
};

function dtStub() {
  const store = new Map<string, string>();
  return {
    setData: (t: string, v: string) => store.set(t, v),
    getData: (t: string) => store.get(t) ?? "",
    effectAllowed: "none",
    dropEffect: "none",
    get types() {
      return Array.from(store.keys());
    },
  };
}

beforeEach(() => endAppDrag());
afterEach(() => cleanup());

describe("ProjectAppRow", () => {
  it("shows the title (and the description as its second line) and opens on click", () => {
    const onOpenApp = vi.fn();
    render(<ProjectAppRow app={app} onOpenApp={onOpenApp} variant="mobile" />);
    expect(screen.getByText("Beds")).toBeTruthy();
    expect(screen.getByText("what grows where")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "App: Beds" }));
    expect(onOpenApp).toHaveBeenCalledWith(6, "beds", "Beds");
  });

  it("menu: Open in new tab, Open standalone, Rename…, Move to — no Share or Archive", async () => {
    render(<ProjectAppRow app={app} variant="desktop" />);
    await userEvent.setup().click(screen.getByTestId("pv-project-app-kebab-trigger"));
    const labels = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Open in new tab", "Open standalone", "Rename…", "Move to"]);
  });

  it("drag carries the app-tile payload and holds the app for drop targets", () => {
    render(<ProjectAppRow app={app} variant="desktop" />);
    const dt = dtStub();
    fireEvent(
      screen.getByRole("button", { name: "App: Beds" }),
      createEvent.dragStart(screen.getByRole("button", { name: "App: Beds" }), { dataTransfer: dt }),
    );
    expect(JSON.parse(dt.getData("application/x-skynet-app-tile"))).toEqual({ hostId: 6, slug: "beds", title: "Beds" });
    expect(dt.effectAllowed).toBe("copyMove");
    expect(getDraggedApp()).toMatchObject({ hostId: "6", slug: "beds", project: "garden" });
  });
});

describe("project section taking a dragged app", () => {
  function section(slug: string, onDropApp = vi.fn(), hostId = "6") {
    render(
      <PrettyProjectSectionHeader
        slug={slug}
        displayName={slug}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        onNewConversationClick={vi.fn()}
        onDropRow={vi.fn()}
        onDropApp={onDropApp}
        hostId={hostId}
        rows={null}
      />,
    );
    return { el: screen.getByTestId(`pv-project-section-${slug}`), onDropApp };
  }

  it("another project on the same machine lights up and moves it on drop", () => {
    const { el, onDropApp } = section("shed");
    const dt = dtStub();
    startAppDrag(dt as unknown as DataTransfer, { hostId: "6", slug: "beds", title: "Beds", owner: null, project: "garden" });
    const over = createEvent.dragOver(el, { dataTransfer: dt });
    fireEvent(el, over);
    expect(over.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("pv-project-drop-overlay-shed")).not.toBeNull();
    fireEvent(el, createEvent.drop(el, { dataTransfer: dt }));
    expect(onDropApp).toHaveBeenCalledWith(expect.objectContaining({ slug: "beds" }));
  });

  it("the app's own project and another machine's project don't take it", () => {
    const own = section("garden");
    const dt = dtStub();
    startAppDrag(dt as unknown as DataTransfer, { hostId: "6", slug: "beds", title: "Beds", owner: null, project: "garden" });
    const over = createEvent.dragOver(own.el, { dataTransfer: dt });
    fireEvent(own.el, over);
    expect(over.defaultPrevented).toBe(false);
    cleanup();
    const far = section("shed", vi.fn(), "7");
    const over2 = createEvent.dragOver(far.el, { dataTransfer: dt });
    fireEvent(far.el, over2);
    expect(over2.defaultPrevented).toBe(false);
  });

  it("an app chip dragged out of a chat (no sidebar drag held) isn't taken", () => {
    const { el } = section("shed");
    const dt = dtStub();
    dt.setData("application/x-skynet-app-tile", JSON.stringify({ hostId: 6, slug: "beds", title: "Beds" }));
    const over = createEvent.dragOver(el, { dataTransfer: dt });
    fireEvent(el, over);
    expect(over.defaultPrevented).toBe(false);
  });
});

describe("a stale held app is never moved", () => {
  it("a drop whose payload names another app does nothing", () => {
    const onDropApp = vi.fn();
    render(
      <PrettyProjectSectionHeader
        slug="shed"
        displayName="shed"
        collapsed={false}
        onToggleCollapse={vi.fn()}
        onNewConversationClick={vi.fn()}
        onDropRow={vi.fn()}
        onDropApp={onDropApp}
        hostId="6"
        rows={null}
      />,
    );
    const el = screen.getByTestId("pv-project-section-shed");
    startAppDrag(dtStub() as unknown as DataTransfer, { hostId: "6", slug: "beds", title: "Beds", owner: null, project: "garden" });
    // A different app's payload (a chip dragged later) while "beds" is still held.
    const dt = dtStub();
    dt.setData("application/x-skynet-app-tile", JSON.stringify({ hostId: 6, slug: "other", title: "Other" }));
    fireEvent(el, createEvent.dragOver(el, { dataTransfer: dt }));
    fireEvent(el, createEvent.drop(el, { dataTransfer: dt }));
    expect(onDropApp).not.toHaveBeenCalled();
  });
});
