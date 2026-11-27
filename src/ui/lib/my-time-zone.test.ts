import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/user-time-zone-api", () => ({
  getMyTimeZone: vi.fn(),
  reportBrowserTimeZone: vi.fn(),
}));

import { getMyTimeZone, reportBrowserTimeZone } from "@/api/user-time-zone-api";
import {
  __resetMyTimeZoneForTests,
  followBrowserTimeZone,
  getMyTimeZoneState,
  isPlainUtc,
  myTimeZone,
  setMyTimeZone,
  wallClockAt,
  wallClockToInstant,
  zoneOffsetMinutes,
} from "./my-time-zone";

const getMock = getMyTimeZone as ReturnType<typeof vi.fn>;
const reportMock = reportBrowserTimeZone as ReturnType<typeof vi.fn>;

function browserIn(zone: string) {
  const real = Intl.DateTimeFormat;
  // A plain function so `new Intl.DateTimeFormat(...)` works on the spy too.
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale?: string, opts?: Intl.DateTimeFormatOptions) {
    const f = new real(locale, opts);
    if (opts?.timeZone) return f;
    return { resolvedOptions: () => ({ ...f.resolvedOptions(), timeZone: zone }) } as Intl.DateTimeFormat;
  } as unknown as typeof Intl.DateTimeFormat);
}

beforeEach(() => {
  __resetMyTimeZoneForTests();
  getMock.mockReset();
  reportMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plain UTC", () => {
  it("knows UTC under its other names, and not fixed offsets", () => {
    for (const z of ["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Zulu", "Universal", "Etc/Zulu", "UCT", "Greenwich"])
      expect(isPlainUtc(z)).toBe(true);
    for (const z of ["Europe/London", "Etc/GMT+5", "America/Denver"]) expect(isPlainUtc(z)).toBe(false);
  });
});

describe("following the browser", () => {
  it("loads the saved zone, then reports a browser that differs", async () => {
    browserIn("America/Denver");
    getMock.mockResolvedValue({ timeZone: "America/New_York", pinned: false });
    reportMock.mockResolvedValue({ timeZone: "America/Denver", pinned: false });
    await followBrowserTimeZone();
    expect(reportMock).toHaveBeenCalledWith("America/Denver");
    expect(getMyTimeZoneState()).toMatchObject({ timeZone: "America/Denver", pinned: false, loaded: true });
    expect(myTimeZone()).toBe("America/Denver");
  });

  it("sends nothing when the browser already matches (each check only re-reads)", async () => {
    browserIn("America/Denver");
    getMock.mockResolvedValue({ timeZone: "America/Denver", pinned: false });
    await followBrowserTimeZone();
    await followBrowserTimeZone();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("picks up a pin made in another tab or device", async () => {
    browserIn("America/Denver");
    getMock.mockResolvedValueOnce({ timeZone: "America/Denver", pinned: false });
    await followBrowserTimeZone();
    getMock.mockResolvedValueOnce({ timeZone: "Asia/Tokyo", pinned: true });
    await followBrowserTimeZone();
    expect(getMyTimeZoneState()).toMatchObject({ timeZone: "Asia/Tokyo", pinned: true });
    expect(myTimeZone()).toBe("Asia/Tokyo");
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("takes the zone back when another browser elsewhere moved it", async () => {
    browserIn("America/Denver");
    getMock.mockResolvedValue({ timeZone: "Europe/Paris", pinned: false });
    reportMock.mockResolvedValue({ timeZone: "America/Denver", pinned: false });
    await followBrowserTimeZone();
    expect(reportMock).toHaveBeenCalledWith("America/Denver");
  });

  it("drops a check's late answer when the person pinned meanwhile", async () => {
    browserIn("America/Denver");
    let answer!: (v: unknown) => void;
    getMock.mockReturnValue(new Promise((r) => (answer = r)));
    const check = followBrowserTimeZone();
    setMyTimeZone({ timeZone: "Asia/Tokyo", pinned: true });
    answer({ timeZone: "America/New_York", pinned: false });
    await check;
    expect(getMyTimeZoneState()).toMatchObject({ timeZone: "Asia/Tokyo", pinned: true });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("sends nothing while pinned", async () => {
    browserIn("America/Denver");
    getMock.mockResolvedValue({ timeZone: "Asia/Tokyo", pinned: true });
    await followBrowserTimeZone();
    expect(reportMock).not.toHaveBeenCalled();
    expect(myTimeZone()).toBe("Asia/Tokyo");
  });

  it("sends nothing from a browser in plain UTC", async () => {
    browserIn("Etc/UTC");
    getMock.mockResolvedValue({ timeZone: "America/New_York", pinned: false });
    await followBrowserTimeZone();
    expect(reportMock).not.toHaveBeenCalled();
    expect(myTimeZone()).toBe("America/New_York");
  });

  it("falls back to the browser's own zone when nothing is saved, UTC included", () => {
    browserIn("Europe/Paris");
    expect(myTimeZone()).toBe("Europe/Paris");
    vi.restoreAllMocks();
    browserIn("UTC");
    expect(myTimeZone()).toBe("UTC");
  });

  it("never throws when the server can't be reached", async () => {
    browserIn("America/Denver");
    getMock.mockRejectedValue(new Error("offline"));
    await expect(followBrowserTimeZone()).resolves.toBeUndefined();
    expect(getMyTimeZoneState().loaded).toBe(false);
  });
});

describe("wall clock in a zone", () => {
  const iso = (w: Parameters<typeof wallClockToInstant>[0], z: string) => new Date(wallClockToInstant(w, z)).toISOString();

  it("reads ordinary times in the zone", () => {
    expect(iso({ year: 2026, month: 7, day: 4, hour: 9, minute: 0 }, "America/New_York")).toBe("2026-07-04T13:00:00.000Z");
    expect(iso({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, "Asia/Kolkata")).toBe("2026-01-05T03:30:00.000Z");
  });

  it("takes a repeated fall-back time at its first occurrence", () => {
    expect(iso({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("lands a skipped spring-forward time after the jump", () => {
    const t = wallClockToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York");
    expect(wallClockAt(t, "America/New_York").hour).toBe(3);
  });

  it("gives offsets in minutes east of UTC", () => {
    expect(zoneOffsetMinutes(Date.UTC(2026, 0, 1), "Australia/Lord_Howe")).toBe(660);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 1), "America/Denver")).toBe(-360);
  });
});
