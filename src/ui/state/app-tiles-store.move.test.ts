// project-scoped apps: Move to shows the app in its new place at once and
// holds it there over frames still describing the old place, until a frame
// agrees, the hold times out, or the request fails.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  publishAppSnapshot,
  publishAppUpdate,
  useAppTiles,
  setPendingAppMove,
  clearPendingAppMove,
  readAppTilesCache,
  __resetForTest,
} from "./app-tiles-store.js";
import type { AppState } from "../api/fleet-status-types.js";

const app: AppState = {
  hostId: "1",
  slug: "beds",
  title: "Beds",
  description: "",
  port: null,
  hasIcon: false,
  createdAtMs: 0,
  isHealthy: true,
  healthMessage: null,
  owner: "alpha",
  project: null,
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "u" }));
  __resetForTest();
});
afterEach(() => vi.useRealTimers());

describe("pending app moves", () => {
  it("shows the app in its project at once and over stale frames, then lets go once a frame agrees", () => {
    publishAppSnapshot([app]);
    const { result } = renderHook(() => useAppTiles());
    act(() => setPendingAppMove("1", "beds", "garden"));
    expect(result.current[0]).toMatchObject({ owner: null, project: "garden" });
    act(() => publishAppUpdate({ ...app, title: "Beds 2" }));
    expect(result.current[0]).toMatchObject({ owner: null, project: "garden", title: "Beds 2" });
    act(() => publishAppUpdate({ ...app, owner: null, project: "garden" }));
    // The hold is gone: a later move back on the machine shows as it is.
    act(() => publishAppUpdate({ ...app, owner: null, project: null }));
    expect(result.current[0]).toMatchObject({ owner: null, project: null });
  });

  it("a refused request puts the app back", () => {
    publishAppSnapshot([app]);
    const { result } = renderHook(() => useAppTiles());
    act(() => setPendingAppMove("1", "beds", null));
    expect(result.current[0]).toMatchObject({ owner: null, project: null });
    act(() => clearPendingAppMove("1", "beds", { owner: "alpha", project: null }));
    expect(result.current[0]).toMatchObject({ owner: "alpha", project: null });
    act(() => publishAppSnapshot([app]));
    expect(result.current[0].owner).toBe("alpha");
  });

  it("a move the machine never carries out lets go after five minutes", () => {
    vi.useFakeTimers();
    publishAppSnapshot([app]);
    const { result } = renderHook(() => useAppTiles());
    act(() => setPendingAppMove("1", "beds", "garden"));
    vi.advanceTimersByTime(301_000);
    act(() => publishAppSnapshot([{ ...app, title: "Beds" }]));
    expect(result.current[0]).toMatchObject({ owner: "alpha", project: null });
  });

  it("the cold-boot cache keeps the project", () => {
    publishAppSnapshot([{ ...app, owner: null, project: "garden" }]);
    expect(readAppTilesCache()[0].project).toBe("garden");
  });
});
