/**
 * tab-url — the new-conversation variant (`new:` / `new:<base64url picks>`),
 * and the picks' wire form it carries.
 */

import { describe, it, expect } from "vitest";
import {
  encodeTabSpec,
  encodeWorkspaceSpec,
  parseTabParam,
  specForTab,
  type TabSpec,
} from "./tab-url";
import { decodeSplitTreeFromUrl, encodeSplitTreeToUrl } from "./split-tree-url";
import type { SplitNode } from "./split-tree";
import { picksFromWire, picksToWire, samePicks } from "./new-conversation-picks";
import type { NewConversationPicks } from "@/types/ui-types";

const FULL: NewConversationPicks = {
  hostId: 7,
  roles: ["box-maintainer", "game-dev"],
  name: "Alicia Smith",
  project: { slug: "tcg-rpg", hostId: 7 },
};

describe("new-conversation TabSpec", () => {
  it("a fresh pane is `new:`", () => {
    expect(encodeTabSpec({ protocol: "new", picks: {} })).toBe("new:");
    expect(parseTabParam("new:")).toEqual({ protocol: "new", picks: {} });
  });

  it("round-trips its picks", () => {
    const spec: TabSpec = { protocol: "new", picks: FULL };
    const wire = encodeTabSpec(spec);
    expect(wire.startsWith("new:")).toBe(true);
    // Nothing that needs escaping in a URL fragment.
    expect(wire.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseTabParam(wire)).toEqual(spec);
  });

  it("round-trips a shell's picks", () => {
    const spec: TabSpec = { protocol: "new", picks: { shell: true, hostId: 3, path: "~/src/my dir" } };
    expect(parseTabParam(encodeTabSpec(spec))).toEqual(spec);
  });

  it("keeps the pane (fresh) when the payload is garbage", () => {
    expect(parseTabParam("new:%%%")).toEqual({ protocol: "new", picks: {} });
    expect(parseTabParam("new:bm90IGpzb24")).toEqual({ protocol: "new", picks: {} });
  });

  it("specForTab builds it from a new-conversation tab, with or without picks", () => {
    expect(specForTab({ type: "new-conversation", newConversation: FULL })).toEqual({ protocol: "new", picks: FULL });
    expect(specForTab({ type: "new-conversation" })).toEqual({ protocol: "new", picks: {} });
  });

  it("survives the split-tree URL round trip next to a conversation — twice over", () => {
    const tree = {
      kind: "split",
      direction: "vertical",
      children: [
        { kind: "session", tabId: "conv" },
        {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "session", tabId: "new-a" },
            { kind: "session", tabId: "new-b" },
          ],
        },
      ],
    } as unknown as SplitNode;
    const specs: Record<string, TabSpec> = {
      conv: { protocol: "tmux", host: "Skynet", session: "sahara" },
      "new-a": { protocol: "new", picks: {} },
      "new-b": { protocol: "new", picks: {} },
    };
    const encoded = encodeSplitTreeToUrl(tree, (id) => specs[id] ?? null);
    const fragment = encodeWorkspaceSpec({ tabs: Object.values(specs), splitTree: encoded });
    const params = new URLSearchParams(fragment);
    const roundTripped = new URLSearchParams({ s: params.get("s")!, t: params.get("t")! }).toString();
    let n = 0;
    const decoded = decodeSplitTreeFromUrl(roundTripped, (spec) =>
      spec.protocol === "new" ? `new-restored-${++n}` : "conv-restored",
    );
    const json = JSON.stringify(decoded);
    expect(json).toContain("new-restored-1");
    expect(json).toContain("new-restored-2");
    expect(json).toContain("conv-restored");
    expect(params.getAll("tab").map(parseTabParam).filter((s) => s?.protocol === "new")).toHaveLength(2);
  });
});

describe("new-conversation picks on the wire", () => {
  it("round-trips every field", () => {
    expect(picksFromWire(JSON.parse(JSON.stringify(picksToWire(FULL))))).toEqual(FULL);
    const shell: NewConversationPicks = { shell: true, hostId: 3, path: "/srv" };
    expect(picksFromWire(picksToWire(shell))).toEqual(shell);
    expect(picksFromWire(picksToWire({ hostId: 3, noRoles: true }))).toEqual({ hostId: 3, noRoles: true });
  });

  it("drops what doesn't check out, keeping the rest", () => {
    expect(
      picksFromWire({
        s: true, // not 1
        h: 0,
        r: ["ok-role", "Bad Role", 5, "ok-role", "a".repeat(65)],
        n: 1, // ignored beside roles
        m: "x".repeat(81),
        p: ["Not A Slug", 7],
        d: 42,
      }),
    ).toEqual({ roles: ["ok-role"] });
    expect(picksFromWire({ h: 12345678901 })).toEqual({});
    expect(picksFromWire({ h: 1.5, m: "   " })).toEqual({});
    expect(picksFromWire({ p: ["tcg-rpg", -1] })).toEqual({});
  });

  it("anything that isn't an object is a fresh pane", () => {
    for (const raw of [null, undefined, 3, "x", [], [1, 2]]) expect(picksFromWire(raw)).toEqual({});
  });

  it("caps the number of roles", () => {
    const many = Array.from({ length: 40 }, (_, i) => `role-${i}`);
    expect(picksFromWire({ r: many }).roles).toHaveLength(32);
  });

  it("samePicks ignores key order and empty fields", () => {
    expect(samePicks({ hostId: 3, roles: ["a"] }, { roles: ["a"], hostId: 3 })).toBe(true);
    expect(samePicks({ roles: [] }, {})).toBe(true);
    expect(samePicks({ roles: ["a", "b"] }, { roles: ["b", "a"] })).toBe(false);
    expect(samePicks({ hostId: 3 }, { hostId: 4 })).toBe(false);
  });
});
