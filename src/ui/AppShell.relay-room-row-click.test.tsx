// A relay room's row goes to the room's open tab when there is one, and a
// change to the user's rooms re-reads the sidebar list. AppShell is too heavy
// to mount here, so — like the sibling relay tests — this checks its source.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "AppShell.tsx"),
  "utf8",
);

describe("AppShell — relay room rows", () => {
  it("a row click reuses the room's open tab before opening a new one", () => {
    const start = src.indexOf("onRelayRoomRowClick={(row) => {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);
    const reuse = body.indexOf('t.sessionKind === "relay-room" && t.relayRoomId === row.roomId');
    const open = body.indexOf("openTab(null");
    expect(reuse).toBeGreaterThan(-1);
    expect(reuse).toBeLessThan(open);
    expect(body).toContain("selectConversationDeferred(existing.id)");
  });

  it("relay-rooms-changed re-reads the session list", () => {
    expect(src).toMatch(/onRelayRoomsChanged: \(\) => \{\s*void fetchFleetSessionsRef\.current\?\.\(\{ isColdStart: false \}\);/);
  });

  it("room tab names are fixed up when a tab opens, not only when the names change", () => {
    expect(src).toContain("}, [relayRoomTitles, relayTabsKey]);");
  });
});
