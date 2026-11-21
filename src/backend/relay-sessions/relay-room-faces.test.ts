import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger.js", () => ({
  databaseLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../database/db/index.js", () => ({ db: {} }));
vi.mock("../database/db/schema.js", () => ({ users: {} }));
vi.mock("../matrix/matrix-room-actions-client.js", () => ({
  getRoomStateAdmin: vi.fn(),
}));

import { loadRoomFacesForViewer } from "./relay-room-faces.js";

const humans = async () => ({
  byMxid: new Map([
    ["@me_human:hs", { displayName: "me", userId: "u-me", avatarPath: null }],
    ["@zed_human:hs", { displayName: "zed", userId: "u-zed", avatarPath: "z.webp" }],
  ]),
  mxidByUserId: new Map([["u-me", "@me_human:hs"]]),
});

describe("loadRoomFacesForViewer", () => {
  it("gives each room its faces without the viewer", async () => {
    const getMembers = vi.fn(async (roomId: string) =>
      roomId === "!a:hs" ? ["@finch:hs", "@me_human:hs", "@zed_human:hs", "@bilbo:hs"] : null,
    );
    const out = await loadRoomFacesForViewer("u-me", ["!a:hs", "!b:hs"], {
      getMembers,
      loadHumans: humans,
      budgetMs: 1000,
    });
    expect(out.get("!a:hs")?.faces.map((f) => f.mxid)).toEqual(["@finch:hs", "@zed_human:hs"]);
    expect(out.get("!a:hs")?.othersCount).toBe(3);
    expect(out.has("!b:hs")).toBe(false); // unreadable room → no faces
  });

  it("doesn't hold the sidebar past its budget", async () => {
    const getMembers = vi.fn(async (roomId: string) =>
      roomId === "!slow:hs"
        ? new Promise<string[]>((r) => setTimeout(() => r(["@finch:hs"]), 500))
        : ["@finch:hs", "@me_human:hs"],
    );
    const started = Date.now();
    const out = await loadRoomFacesForViewer("u-me", ["!fast:hs", "!slow:hs"], {
      getMembers,
      loadHumans: humans,
      budgetMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(400);
    expect(out.has("!fast:hs")).toBe(true);
    expect(out.has("!slow:hs")).toBe(false);
  });
});
