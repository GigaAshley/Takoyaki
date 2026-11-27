/**
 * POST /identities/:key/project — Move to / Remove from project for an agent, through the
 * machine's front door. `project:` frontmatter is the source of truth for which project an
 * agent's conversation is in; pinned and in a project are one or the other (the inverse is
 * in identity-pin.ts).
 *
 * Mounted at /identities in database.ts AFTER identity-archive so the :key/project
 * sub-route isn't shadowed by identitiesRoutes's :identityKey handlers.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { IDENTITY_KEY_RE, PROJECT_SLUG_RE } from "../../claude-session/identity-artifact-reader.js";
import { getSubscriptionRegistry } from "../../fleet-status/subscription-registry.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, askerFor, parseHostId } from "../../fleet-change/front-door-route.js";
import { HttpError } from "../../sharing/host-conn.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

/**
 * POST /:key/project  body: { hostId: number, project: string | null, requestId?: string }
 *
 * Move an agent into a project (or out of one, null) through the machine's front door
 * (fleet-change agent-project): in turn with the machine's other changes, only the agent
 * file's `project:` line changed. Moving in unpins (pinned and in a project are one or
 * the other).
 *
 *   → 200 { ok: true, requestId, result: { name, project, unpinned } }
 *   → 202 still waiting its turn; 503 { code: "updating" } the machine is still updating
 *   → 409 { error, code }: project_archived / project_not_found (the project is gone by its
 *     turn, or hidden from the caller), being_archived (the agent's archive is claimed),
 *     not_found / archived
 *   → 503 when who's asking can't be told on a machine several people share
 *   → 400 bad hostId / key / project; 404 not the caller's host; 504 unreachable
 */
router.post(
  "/:key/project",
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const userId = (req as AuthenticatedRequest).userId;
    const body = (req.body ?? {}) as { hostId?: unknown; project?: unknown; requestId?: unknown };
    const rawHostId = body.hostId;
    if (rawHostId === undefined || rawHostId === null || rawHostId === "") {
      res.status(400).json({ error: "hostId is required" });
      return;
    }
    const hostId = parseHostId(rawHostId);
    if (hostId === null) {
      res.status(400).json({ error: "hostId must be a positive integer" });
      return;
    }
    const key = String(req.params.key ?? "");
    if (!key || !IDENTITY_KEY_RE.test(key)) {
      res.status(400).json({ error: "identity key must match [a-z0-9_-]{1,64}" });
      return;
    }
    // `project` must be present: null clears, a slug sets. No field is not a choice.
    const rawProject = body.project;
    if (!("project" in body) || (rawProject !== null && (typeof rawProject !== "string" || !PROJECT_SLUG_RE.test(rawProject)))) {
      res.status(400).json({ error: "project must be a string matching [a-z0-9-]{1,64} or null" });
      return;
    }
    const project = rawProject as string | null;
    // A project hidden from the caller answers like one that's gone.
    let asker: string | null = null;
    if (project !== null) {
      try {
        asker = await askerFor(userId, hostId);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
    await answerFromFrontDoor(res, {
      hostId,
      userId,
      kind: "agent-project",
      args: { name: key, project, asker },
      requestId: requestIdFrom(body.requestId),
      operation: "session_project_write",
      // Open sidebars move the row (session-project-changed carries { identityKey, hostId, project }).
      onDone: async () => {
        getSubscriptionRegistry()?.publishSessionProjectChanged(key, hostId, project);
      },
    });
  },
);

// Generic 500 fallback error handler (mirrors sibling routes).
router.use(
  (
    err: Error,
    _req: Request,
    res: Response,
    _next: express.NextFunction,
  ) => {
    return res
      .status(500)
      .json({ error: err?.message ?? "session-project-write route error" });
  },
);

export default router;
