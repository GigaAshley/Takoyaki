/**
 * app-move-plan.ts — what a "Move to" on an app asks the machine to do.
 *
 * Pure: takes the app as the fleet sweep sees it (its conversation or its
 * project), where it's going, one machine's people / agents / roles /
 * projects, and who is asking; returns the request the agent-supervisor
 * carries out (move-app.sh), or why it's refused.
 *
 * Who can see the app afterwards:
 *   - Into a project: whoever can see that project. The app keeps no list.
 *   - To the sidebar: exactly the people who could see it where it was —
 *     the conversation's audience for a conversation app, the project's for
 *     a project app — written as its "Shared with" list, so moving an app to
 *     the sidebar never shows it to anyone new. When that is everyone on the
 *     machine there is no list.
 *
 * Shape: .planning/shape-project-scoped-apps.md
 */

import {
  agentVisibleTo,
  projectVisibleTo,
  type ShareHostState,
} from "../sharing/sharing-plan.js";

export interface MovingApp {
  slug: string;
  owner: string | null;
  project: string | null;
  /** The sweep's list for a sidebar app (a project app's carries its project's audience). */
  users: string[] | null;
}

export type MoveDestination = { to: "sidebar" } | { to: "project"; project: string };

export type MoveRequest =
  | { to: "sidebar"; users: string[] | null }
  | { to: "project"; project: string };

// `never` on the off-branch fields keeps them readable without discriminant
// narrowing (the backend tsconfig doesn't narrow it).
export type MovePlan =
  | { ok: true; request: MoveRequest; status?: never; error?: never }
  | { ok: false; status: number; error: string; request?: never };

const hasList = (u: string[] | null | undefined): u is string[] => Array.isArray(u) && u.length > 0;

/** Whether `person` can see the app where it is now. */
export function appVisibleTo(app: MovingApp, state: ShareHostState, person: string): boolean {
  if (app.owner !== null) {
    const agent = state.agents.find((a) => a.name === app.owner);
    if (agent === undefined) return false;
    return agentVisibleTo(agent, new Map(state.roles.map((r) => [r.name, r])), person);
  }
  if (app.project !== null) return projectVisibleTo(state.projects, app.project, person);
  return !hasList(app.users) || app.users.includes(person);
}

export function planAppMove(
  app: MovingApp,
  dest: MoveDestination,
  state: ShareHostState,
  /** The person asking; null on a machine whose people couldn't be told apart (single user). */
  you: string | null,
): MovePlan {
  const multiUser = state.people.length > 1;
  // On a shared machine an unknown caller sees nothing (fails closed).
  if (multiUser && (you === null || !appVisibleTo(app, state, you))) {
    return { ok: false, status: 404, error: "Not found" };
  }

  if (dest.to === "project") {
    if (app.project === dest.project) return { ok: false, status: 409, error: "already in that project" };
    const exists = state.projects.some((p) => p.slug === dest.project);
    const visible = !multiUser || (you !== null && projectVisibleTo(state.projects, dest.project, you));
    if (!exists || !visible) return { ok: false, status: 404, error: "project not found" };
    return { ok: true, request: { to: "project", project: dest.project } };
  }

  if (app.owner === null && app.project === null) {
    return { ok: false, status: 409, error: "already in the sidebar" };
  }
  if (!multiUser) return { ok: true, request: { to: "sidebar", users: null } };
  const audience = state.people.filter((p) => appVisibleTo(app, state, p));
  // Nobody on the machine can see it (a list naming only former people):
  // there is no list that keeps it as narrow, so don't widen it to everyone.
  if (audience.length === 0) {
    return { ok: false, status: 409, error: "nobody on this machine can see it now" };
  }
  const everyone = state.people.every((p) => audience.includes(p));
  return { ok: true, request: { to: "sidebar", users: everyone ? null : audience } };
}
