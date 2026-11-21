import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, act, fireEvent } from "@testing-library/react";
import type { Identity } from "@/api/identities-api";
import type {
  HumanParticipant,
  AgentParticipant,
} from "./sources/relay-room-api";

function makeIdentity(
  identityKey: string,
  displayName: string,
  colorHue: number,
): Identity {
  return {
    identityKey,
    displayName,
    title: null,
    colorHue,
    voice: null,
    role: null,
    avatarMime: "image/png",
    avatarUrl: "/avatar.png",
    avatarEtag: "abc",
    coordinator: false,
    task: null,
  } as Identity;
}

const IDENTITIES_BY_KEY = new Map<string, Identity>([
  ["riley", makeIdentity("riley", "Riley", 30)],
  ["ada", makeIdentity("ada", "Ada", 90)],
  ["nelly", makeIdentity("nelly", "Nelly", 150)],
  ["bare-agent", makeIdentity("bare-agent", "Bare Agent", 200)],
]);

vi.mock("@/state/identities-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useIdentities: vi.fn(() => ({
      identities: Array.from(IDENTITIES_BY_KEY.values()),
      byKey: IDENTITIES_BY_KEY,
      loaded: true,
      refresh: vi.fn(),
    })),
  };
});

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

// AgentBadgeWithMeter transitively reads from these stores — mock them so
// the anchor tests do not require the real fleet-status subscription.
vi.mock("@/state/session-working-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useSessionIsWorking: vi.fn(() => false),
    useSessionIsCondensing: vi.fn(() => false),
  };
});

vi.mock("@/api/fleet-status-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useSessionContextPct: vi.fn(() => null),
  };
});

vi.mock("@/main-axios", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    authApi: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

// Spy-mock IdentityBadge so we can inspect the props each badge cell passes.
// Renders a marker div with data-testid + data-tabid + data-has-onclick so
// the tests can grep the props off the DOM (avoids fragile spy-array
// bookkeeping).
const identityBadgePropsSpy = vi.fn();
vi.mock("@/features/terminal/IdentityBadge", () => ({
  IdentityBadge: (props: {
    identityKey?: string;
    tabId?: string;
    onClick?: unknown;
  }) => {
    identityBadgePropsSpy(props);
    return (
      <div
        data-testid="identity-badge-spy"
        data-identity-key={props.identityKey ?? ""}
        data-tabid={props.tabId ?? ""}
        data-has-onclick={props.onClick != null ? "true" : "false"}
      />
    );
  },
}));

import { MultiBadgeAnchor } from "./MultiBadgeAnchor";

const VIEWER = "@viewer:hs";
const ZOEY = { mxid: "@zoey:hs", displayName: "Zoey", userId: "u-zoey", avatarPath: "zoey.webp" };
const NOPIC = { mxid: "@sam:hs", displayName: "Sam", userId: "u-sam", avatarPath: null };
const ME = { mxid: VIEWER, displayName: "Viewer", userId: "u-me", avatarPath: null };

function stubLayout(paneWidth: number, rowWidth: number) {
  const pane = document.createElement("div");
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => pane });
  Object.defineProperty(pane, "clientWidth", { configurable: true, get: () => paneWidth });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => rowWidth });
}

function unstubLayout() {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
}

function renderRow(agents: AgentParticipant[] = [{ mxid: "@nelly:hs", identityKey: "nelly" }]) {
  return render(
    <MultiBadgeAnchor
      participants={{ humans: [ZOEY, NOPIC, ME] as HumanParticipant[], agents }}
      viewingUserMxid={VIEWER}
      fleetIdentityHosts={{ nelly: 5 }}
      isReady={true}
    />,
  );
}

describe("MultiBadgeAnchor — people in the room", () => {
  beforeEach(() => unstubLayout());

  it("every other person gets a badge with their name; the viewer gets none", () => {
    const { container } = renderRow();
    const people = Array.from(container.querySelectorAll('[data-role="human"]'));
    expect(people.map((p) => p.getAttribute("data-mxid"))).toEqual(["@sam:hs", "@zoey:hs"]);
    expect(container.textContent).toContain("Zoey");
    expect(container.textContent).toContain("Sam");
    expect(container.querySelector(`[data-mxid="${VIEWER}"]`)).toBeNull();
  });

  it("a person's badge shows their picture, or their initial when they have none, and no memory pie", () => {
    const { container } = renderRow();
    const zoey = container.querySelector('[data-mxid="@zoey:hs"]')!;
    expect(zoey.querySelector("img")?.getAttribute("src")).toBe("/users/u-zoey/avatar?f=zoey.webp");
    const sam = container.querySelector('[data-mxid="@sam:hs"]')!;
    expect(sam.querySelector("img")).toBeNull();
    expect(sam.textContent).toContain("S");
    expect(zoey.querySelector('[data-appendage="true"]')).toBeNull();
  });

  it("people sit to the left of agents (after them in the reversed row)", () => {
    const { container } = renderRow();
    const roles = Array.from(container.querySelectorAll('[data-testid="relay-room-participant"]')).map((c) =>
      c.getAttribute("data-role"),
    );
    expect(roles).toEqual(["agent", "human", "human"]);
  });

  it("a member the app can't draw as an agent still gets a plain badge with their name", () => {
    const { container } = renderRow([{ mxid: "@stranger:other", identityKey: "stranger" }]);
    const cell = container.querySelector('[data-mxid="@stranger:other"]')!;
    expect(cell.querySelector('[data-testid="relay-room-person-badge"]')).not.toBeNull();
    expect(cell.textContent).toContain("stranger");
  });

  it("keeps names when everything fits", () => {
    stubLayout(1200, 400);
    const { container } = renderRow();
    expect(container.querySelector('[data-testid="multi-badge-anchor"]')?.getAttribute("data-tight")).toBe("false");
    expect(container.querySelector('[data-mxid="@zoey:hs"]')?.getAttribute("title")).toBeNull();
  });

  it("goes to pictures only for every badge when the row doesn't fit, with the name on hover", () => {
    stubLayout(390, 520);
    const { container } = renderRow();
    const row = container.querySelector('[data-testid="multi-badge-anchor"]')!;
    expect(row.getAttribute("data-tight")).toBe("true");
    expect(row.className).toContain("[&_.pv-badge-name]:hidden");
    for (const cell of Array.from(container.querySelectorAll('[data-testid="relay-room-participant"]'))) {
      expect(cell.getAttribute("title")).toBeTruthy();
    }
    expect(container.querySelector('[data-mxid="@zoey:hs"]')?.getAttribute("title")).toBe("Zoey");
  });

  it("press-and-hold on a touch screen shows the name; a short tap shows nothing", () => {
    vi.useFakeTimers();
    stubLayout(390, 520);
    const { container } = renderRow();
    const zoey = container.querySelector('[data-mxid="@zoey:hs"]')!;
    fireEvent.pointerDown(zoey, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(zoey, { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(600));
    expect(container.querySelector('[data-testid="relay-room-participant-name"]')).toBeNull();
    fireEvent.pointerDown(zoey, { pointerType: "touch", clientX: 5, clientY: 5 });
    act(() => vi.advanceTimersByTime(600));
    expect(container.querySelector('[data-testid="relay-room-participant-name"]')?.textContent).toBe("Zoey");
    act(() => vi.advanceTimersByTime(2100));
    expect(container.querySelector('[data-testid="relay-room-participant-name"]')).toBeNull();
    vi.useRealTimers();
  });

  it("a very crowded row wraps its pictures within the space instead of running off", () => {
    stubLayout(390, 900);
    const { container } = renderRow();
    const row = container.querySelector('[data-testid="multi-badge-anchor"]') as HTMLElement;
    expect(row.getAttribute("data-tight")).toBe("true");
    expect(row.className).toContain("flex-wrap");
    expect(row.style.maxWidth).toBe(`${390 - 72 - 20}px`);
  });

  it("a touch hold never opens the system menu, even when the main pointer is a mouse", () => {
    stubLayout(390, 520);
    const { container } = renderRow();
    const zoey = container.querySelector('[data-mxid="@zoey:hs"]')!;
    fireEvent.pointerDown(zoey, { pointerType: "touch", clientX: 5, clientY: 5 });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    zoey.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it("screen readers hear every member's name", () => {
    const { container } = renderRow();
    const names = Array.from(container.querySelectorAll(".sr-only")).map((n) => n.textContent);
    expect(names).toEqual(expect.arrayContaining(["Zoey", "Sam", "Nelly"]));
  });
});
