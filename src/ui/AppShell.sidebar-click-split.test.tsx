// A sidebar click while a split is up joins the split (or focuses the pane
// it's already in) for every kind of row; app tiles from the sidebar focus an
// app already in a pane, while app chips keep opening a copy. AppShell is too
// heavy to mount here, so — like the sibling relay tests — this checks its
// source; the placement decisions themselves are tested in
// search-result-open.test.ts and sidebar-app-open.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "AppShell.tsx"),
  "utf8",
);

const handler = (marker: string, len = 3000): string => {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + len);
};

describe("AppShell — sidebar clicks join an open split", () => {
  it("a not-yet-open conversation row is placed before it's selected", () => {
    const body = handler("onDetachedRowClick={(row) => {", 1200);
    const place = body.indexOf('placeSidebarOpen(newTabId, "detached", row.id)');
    expect(place).toBeGreaterThan(-1);
    expect(place).toBeLessThan(body.indexOf("selectConversationDeferred(newTabId)"));
  });

  it("a quick second click on a not-yet-open row reuses its tab", () => {
    const body = handler("onDetachedRowClick={(row) => {", 900);
    expect(body.indexOf("findOpenResultTab(tabsRef.current, host.id, sessionName, false)")).toBeLessThan(
      body.indexOf("openTab(host"),
    );
  });

  it("an already-open row is placed, but only while its tab exists", () => {
    const body = handler("onOpenRowClick={(row) => {", 500);
    expect(body.indexOf("tabsRef.current.some((t) => t.id === row.id)")).toBeLessThan(
      body.indexOf("placeSidebarOpen(row.id,"),
    );
  });

  it("an RDP machine row is placed", () => {
    expect(handler("onRdpRowClick={(row) => {", 400)).toContain('placeSidebarOpen(newTabId, "rdp", row.id)');
  });

  it("a relay room is placed whether it's already open or new", () => {
    const body = handler("onRelayRoomRowClick={(row) => {");
    expect(body).toContain('placeSidebarOpen(existing.id, "relay-room", row.id)');
    expect(body).toContain('placeSidebarOpen(newTabId, "relay-room", row.id)');
  });

  it("sidebar app tiles focus an app already in a pane; chips don't", () => {
    expect(src).toContain('onOpenApp={(hostId, slug, title) => onOpenApp(hostId, slug, title, "sidebar")}');
    const body = handler("const onOpenApp = useCallback(", 1200);
    expect(body).toMatch(/from === "sidebar"\s*\?\s*findAppPaneTab\(/);
    // The chat-chip event path still calls it without "sidebar".
    expect(src).toContain("onOpenApp(d.hostId, d.slug, d.title || d.slug);");
  });
});
