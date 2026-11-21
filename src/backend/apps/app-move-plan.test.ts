import { describe, expect, it } from "vitest";
import { appVisibleTo, planAppMove, type MovingApp } from "./app-move-plan.js";
import type { ShareHostState } from "../sharing/sharing-plan.js";

const state: ShareHostState = {
  people: ["ann", "bob", "cy"],
  agents: [
    { name: "alpha", label: "Alpha", roles: ["gardener"], project: null, users: ["ann", "bob"] },
    { name: "open", label: "Open", roles: [], project: null, users: null },
  ],
  roles: [{ name: "gardener", label: "Gardener", users: ["bob", "cy"], instanceWide: false }],
  projects: [
    { slug: "outer", label: "Outer", parent: null, users: ["ann", "bob"] },
    { slug: "inner", label: "Inner", parent: "outer", users: ["bob", "cy"] },
    { slug: "public", label: "Public", parent: null, users: null },
  ],
  apps: [],
  tasks: [],
};

const convo: MovingApp = { slug: "tally", owner: "alpha", project: null, users: null };
const inProject: MovingApp = { slug: "beds", owner: null, project: "inner", users: ["bob"] };
const sidebar: MovingApp = { slug: "side", owner: null, project: null, users: null };

describe("appVisibleTo", () => {
  it("follows the agent (its own list and its roles') for a conversation app", () => {
    expect(appVisibleTo(convo, state, "bob")).toBe(true);
    expect(appVisibleTo(convo, state, "ann")).toBe(false); // the role hides it
  });
  it("follows the project chain for a project app", () => {
    expect(appVisibleTo(inProject, state, "bob")).toBe(true);
    expect(appVisibleTo(inProject, state, "cy")).toBe(false); // outer hides it
  });
});

describe("planAppMove", () => {
  it("a conversation app moving to the sidebar keeps the conversation's audience as its list", () => {
    expect(planAppMove(convo, { to: "sidebar" }, state, "bob")).toEqual({
      ok: true,
      request: { to: "sidebar", users: ["bob"] },
    });
  });

  it("a project app leaving a limited project keeps the project's audience", () => {
    expect(planAppMove(inProject, { to: "sidebar" }, state, "bob")).toEqual({
      ok: true,
      request: { to: "sidebar", users: ["bob"] },
    });
  });

  it("an app everyone could see gets no list in the sidebar", () => {
    const open: MovingApp = { slug: "o", owner: null, project: "public", users: null };
    expect(planAppMove(open, { to: "sidebar" }, state, "cy")).toEqual({
      ok: true,
      request: { to: "sidebar", users: null },
    });
  });

  it("moving into a project carries no list (the project's audience applies)", () => {
    expect(planAppMove(sidebar, { to: "project", project: "inner" }, state, "bob")).toEqual({
      ok: true,
      request: { to: "project", project: "inner" },
    });
  });

  it("refuses moving to where it already is", () => {
    expect(planAppMove(sidebar, { to: "sidebar" }, state, "bob")).toMatchObject({ ok: false, status: 409 });
    expect(planAppMove(inProject, { to: "project", project: "inner" }, state, "bob")).toMatchObject({ ok: false, status: 409 });
  });

  it("answers not found for a project that doesn't exist or is hidden from the caller", () => {
    expect(planAppMove(sidebar, { to: "project", project: "nope" }, state, "bob")).toMatchObject({ ok: false, status: 404 });
    expect(planAppMove(sidebar, { to: "project", project: "inner" }, state, "ann")).toMatchObject({ ok: false, status: 404 });
  });

  it("answers not found for an app hidden from the caller", () => {
    expect(planAppMove(convo, { to: "sidebar" }, state, "ann")).toMatchObject({ ok: false, status: 404 });
  });

  it("an app nobody on the machine can see (non-overlapping lists) is not found", () => {
    // A caller from outside the machine's people list (an admin, say) moving
    // an app in a sub-project whose list doesn't overlap its parent's.
    const s2: ShareHostState = {
      ...state,
      projects: [...state.projects, { slug: "lost", label: "Lost", parent: "outer", users: ["cy", "zed"] }],
    };
    const lost: MovingApp = { slug: "x", owner: null, project: "lost", users: null };
    expect(planAppMove(lost, { to: "sidebar" }, s2, "zed")).toMatchObject({ ok: false, status: 404 });
  });

  it("an unknown caller on a shared machine sees nothing", () => {
    expect(planAppMove(sidebar, { to: "project", project: "public" }, state, null)).toMatchObject({ ok: false, status: 404 });
  });

  it("on a single-person machine never writes a list", () => {
    const solo: ShareHostState = { ...state, people: ["ann"] };
    expect(planAppMove(convo, { to: "sidebar" }, solo, "ann")).toEqual({
      ok: true,
      request: { to: "sidebar", users: null },
    });
  });
});
