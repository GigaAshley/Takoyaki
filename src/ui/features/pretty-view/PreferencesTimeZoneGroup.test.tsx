/**
 * Preferences → Time zone: what the person sees and what each action sends.
 * Following the browser, pinning from the searchable list, changing a pin,
 * unpinning back to this browser, a failed save, and a zone not known yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/api/user-time-zone-api", () => ({
  getMyTimeZone: vi.fn(),
  reportBrowserTimeZone: vi.fn(),
  pinMyTimeZone: vi.fn(),
  unpinMyTimeZone: vi.fn(),
}));

import {
  getMyTimeZone,
  pinMyTimeZone,
  reportBrowserTimeZone,
  unpinMyTimeZone,
} from "@/api/user-time-zone-api";
import { __resetMyTimeZoneForTests, getMyTimeZoneState } from "@/lib/my-time-zone";
import { PreferencesTimeZoneGroup, timeZoneLabel } from "./PreferencesTimeZoneGroup";

const getMock = getMyTimeZone as ReturnType<typeof vi.fn>;
const reportMock = reportBrowserTimeZone as ReturnType<typeof vi.fn>;
const pinMock = pinMyTimeZone as ReturnType<typeof vi.fn>;
const unpinMock = unpinMyTimeZone as ReturnType<typeof vi.fn>;

const value = () => screen.getByTestId("preferences-time-zone-value").textContent;
const mode = () => screen.getByTestId("preferences-time-zone-mode").textContent;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  __resetMyTimeZoneForTests();
});

describe("Preferences → Time zone", () => {
  it("shows a followed zone with Pin…", () => {
    __resetMyTimeZoneForTests({ timeZone: "America/New_York", pinned: false, loaded: true });
    render(<PreferencesTimeZoneGroup />);
    expect(value()).toBe("America/New York");
    expect(mode()).toContain("Follows this browser");
    expect(screen.getByTestId("preferences-time-zone-pick").textContent).toBe("Pin…");
    expect(screen.queryByTestId("preferences-time-zone-unpin")).toBeNull();
  });

  it("pins a zone picked from the searchable list", async () => {
    __resetMyTimeZoneForTests({ timeZone: "America/New_York", pinned: false, loaded: true });
    pinMock.mockResolvedValue({ timeZone: "America/Denver", pinned: true });
    const user = userEvent.setup();
    render(<PreferencesTimeZoneGroup />);

    await user.click(screen.getByTestId("preferences-time-zone-pick"));
    await user.type(screen.getByTestId("preferences-time-zone-search"), "denv");
    const options = screen.getAllByTestId("preferences-time-zone-option");
    expect(options.map((o) => o.textContent)).toEqual(["America/Denver"]);
    await user.click(options[0]);

    expect(pinMock).toHaveBeenCalledWith("America/Denver");
    await waitFor(() => expect(mode()).toContain("Pinned"));
    expect(value()).toBe("America/Denver");
    expect(screen.queryByTestId("preferences-time-zone-picker")).toBeNull();
    expect(screen.getByTestId("preferences-time-zone-pick").textContent).toBe("Change…");
    expect(getMyTimeZoneState()).toMatchObject({ timeZone: "America/Denver", pinned: true });
  });

  it("matches words in any order, with spaces for underscores", async () => {
    __resetMyTimeZoneForTests({ timeZone: null, pinned: false, loaded: true });
    const user = userEvent.setup();
    render(<PreferencesTimeZoneGroup />);
    await user.click(screen.getByTestId("preferences-time-zone-pick"));
    await user.type(screen.getByTestId("preferences-time-zone-search"), "york new");
    expect(screen.getAllByTestId("preferences-time-zone-option").map((o) => o.textContent)).toContain("America/New York");
    await user.clear(screen.getByTestId("preferences-time-zone-search"));
    await user.type(screen.getByTestId("preferences-time-zone-search"), "zzzz");
    expect(screen.queryAllByTestId("preferences-time-zone-option")).toHaveLength(0);
    await user.click(screen.getByTestId("preferences-time-zone-cancel"));
    expect(screen.queryByTestId("preferences-time-zone-picker")).toBeNull();
  });

  it("offers plain UTC to pin", async () => {
    __resetMyTimeZoneForTests({ timeZone: null, pinned: false, loaded: true });
    const user = userEvent.setup();
    render(<PreferencesTimeZoneGroup />);
    await user.click(screen.getByTestId("preferences-time-zone-pick"));
    await user.type(screen.getByTestId("preferences-time-zone-search"), "utc");
    expect(screen.getAllByTestId("preferences-time-zone-option").map((o) => o.textContent)).toContain("UTC");
  });

  it("unpins back to following this browser", async () => {
    __resetMyTimeZoneForTests({ timeZone: "Asia/Tokyo", pinned: true, loaded: true });
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    unpinMock.mockResolvedValue({ timeZone: "Europe/Paris", pinned: false });
    const user = userEvent.setup();
    render(<PreferencesTimeZoneGroup />);
    expect(mode()).toContain("Pinned");

    await user.click(screen.getByTestId("preferences-time-zone-unpin"));
    expect(unpinMock).toHaveBeenCalledWith(browser);
    await waitFor(() => expect(mode()).toContain("Follows this browser"));
    expect(value()).toBe("Europe/Paris");
  });

  it("says so when pinning fails, and keeps the zone as it was", async () => {
    __resetMyTimeZoneForTests({ timeZone: "America/New_York", pinned: false, loaded: true });
    pinMock.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<PreferencesTimeZoneGroup />);
    await user.click(screen.getByTestId("preferences-time-zone-pick"));
    await user.type(screen.getByTestId("preferences-time-zone-search"), "denver");
    await user.click(screen.getAllByTestId("preferences-time-zone-option")[0]);
    expect(await screen.findByTestId("preferences-time-zone-error")).toBeTruthy();
    expect(value()).toBe("America/New York");
  });

  it("loads the zone when it isn't known yet", async () => {
    getMock.mockResolvedValue({ timeZone: null, pinned: false });
    reportMock.mockResolvedValue({ timeZone: null, pinned: false });
    render(<PreferencesTimeZoneGroup />);
    expect(mode()).toBe("Checking…");
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(value()).toBe("Not set"));
  });

  it("labels zones readably", () => {
    expect(timeZoneLabel("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos Aires");
  });
});
