/**
 * project-scoped apps: POST /apps/:hostId/:slug/move
 *
 * "Move to" on any app — to the sidebar or into a project. The machine does
 * the move, no agent is asked: this route sends it to the machine's front
 * door (fleet-change app-move), which carries it out in arrival order with
 * the machine's other changes, and waits for the outcome. The app keeps its
 * address, data and icon. When a conversation app leaves its agent, the
 * front door tells that agent.
 *
 * Body: { to: "sidebar" } | { to: "project", project: "<slug>" }, plus an
 * optional requestId (the client's, so a retried click is one move).
 *
 * Who can see it afterwards is decided here (app-move-plan.ts): a move to the
 * sidebar carries the audience the app had as its "Shared with" list.
 *
 *   → 200 { ok: true, result }   moved
 *   → 202 { pending: true, requestId }  still waiting or running after the wait
 *   → 409 { error, code }  refused by the machine (e.g. the project is archived)
 *   → 500 { error, code }  the move failed on the machine (it stays where it was)
 *   → 503 { code: "updating" }  the machine's update after a deploy hasn't finished
 *   → 400 bad hostId / slug / body
 *   → 404 host unknown to the caller, app unknown or hidden from the caller,
 *         destination project unknown or hidden (one shape — no probe leak)
 *   → 409 already there, or no audience to keep
 *   → 503 app registry not yet available
 *   → 504 host unreachable
 *   → 500 request write failed
 *
 * Shape: .planning/shape-project-scoped-apps.md
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import {
  APP_SLUG_RE,
  PROJECT_SLUG_RE,
  listProjects,
} from "../../claude-session/identity-artifact-reader.js";
import { frontDoorHttp, requestIdFrom, submitFrontDoor, type FrontDoorOutcome } from "../../fleet-change/front-door.js";
import { getRegistry } from "../../fleet-status/registry-holder.js";
import { listMachinePeople } from "../../distributor/machine-people.js";
import { getUsernameForUserId } from "../../utils/host-user-counter.js";
import { readShareHostState } from "../../sharing/sharing-host.js";
import type { ShareHostState } from "../../sharing/sharing-plan.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import { planAppMove, type MoveDestination } from "../../apps/app-move-plan.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

function parseDestination(body: unknown): MoveDestination | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.to === "sidebar") return { to: "sidebar" };
  if (b.to === "project" && typeof b.project === "string" && PROJECT_SLUG_RE.test(b.project) && b.project !== "archive") {
    return { to: "project", project: b.project };
  }
  return null;
}

router.post("/:hostId/:slug/move", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;

  const hostId = Number(req.params.hostId);
  if (!Number.isInteger(hostId) || hostId <= 0) {
    return res.status(400).json({ error: "hostId must be a positive integer" });
  }
  const slug = String(req.params.slug);
  if (!APP_SLUG_RE.test(slug)) {
    return res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
  }
  const dest = parseDestination(req.body);
  if (dest === null) {
    return res.status(400).json({ error: 'body must be { to: "sidebar" } or { to: "project", project }' });
  }

  const registry = getRegistry();
  if (registry === null) {
    return res.status(503).json({ error: "app registry not yet available" });
  }
  const known = registry.getAppSnapshot().find((a) => a.hostId === String(hostId) && a.slug === slug);
  if (!known) {
    return res.status(404).json({ error: "Not found" });
  }
  const app = {
    slug,
    owner: known.owner ?? null,
    project: known.project ?? null,
    users: known.users ?? null,
  };

  const requestId = requestIdFrom((req.body as { requestId?: unknown } | undefined)?.requestId);
  try {
    const people = ((await listMachinePeople(hostId)) ?? []).map((p) => p.username);
    const you = await getUsernameForUserId(userId);
    const outcome: FrontDoorOutcome = await withHost(hostId, userId, async (conn) => {
      // One person on the machine: nothing to work out about who sees what,
      // only that the destination project exists.
      const state: ShareHostState =
        people.length > 1
          ? await readShareHostState(conn, people, "all")
          : {
              people,
              agents: [],
              roles: [],
              projects: (await listProjects(conn)).map((p) => ({
                slug: p.slug,
                label: p.displayName,
                parent: p.parent ?? null,
                users: null,
              })),
              apps: [],
              tasks: [],
            };
      const plan = planAppMove(app, dest, state, you ?? null);
      if (!plan.ok || plan.request === undefined) throw new HttpError(plan.status ?? 500, plan.error ?? "can't move");
      const request = plan.request;
      const result = await submitFrontDoor(conn, "app-move", { slug, ...request }, { id: requestId, hostId, by: userId });
      databaseLogger.info("app move requested", {
        operation: "apps_move_request",
        userId,
        hostId,
        slug,
        from: app.owner !== null ? `conversation:${app.owner}` : app.project !== null ? `project:${app.project}` : "sidebar",
        to: request.to === "project" ? `project:${request.project}` : "sidebar",
        limited: request.to === "sidebar" && request.users !== null,
        requestId,
        outcome: result.state,
        code: "code" in result ? result.code : undefined,
      });
      return result;
    });
    const { status, body } = frontDoorHttp(outcome);
    return res.status(status).json(body);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.status === 404 ? "Not found" : err.message });
    }
    databaseLogger.error("app move request failed", {
      operation: "apps_move_request_failed",
      hostId,
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "failed to request the move" });
  }
});

export default router;
