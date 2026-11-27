/**
 * POST /apps/:hostId/:slug/archive  body: { requestId?: string }
 *
 * Archive a sidebar app: a request to the machine's front door
 * (fleet-change app-archive), carried out in arrival order with the machine's
 * other changes — the app's units are stopped and kept in its folder, and the
 * folder moves to ~/fleet/apps-archive/. A project's apps go with their
 * project and a conversation's with their conversation (both refused here).
 *
 *   → 200 { ok: true, requestId, result }  archived (alreadyArchived on a repeat)
 *   → 202 { pending: true, requestId }  still waiting its turn after the wait
 *   → 409 { error, code }  refused (project_app, conversation_app, archive_slot_taken, not_found)
 *   → 500 { error, code }  the archive failed on the machine
 *   → 503 { code: "updating" }  the machine's update hasn't finished
 *   → 400 bad hostId / slug; 404 not the caller's host; 504 unreachable
 *
 * hostId is in the path, as for every app route (apps are keyed on hostId + slug).
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { APP_SLUG_RE } from "../../claude-session/identity-artifact-reader.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.post("/:hostId/:slug/archive", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const hostId = parseHostId(req.params.hostId);
  if (hostId === null) {
    return res.status(400).json({ error: "hostId must be a positive integer" });
  }
  const slug = String(req.params.slug);
  if (!APP_SLUG_RE.test(slug)) {
    return res.status(400).json({ error: "slug must match [a-z0-9-]{1,64}" });
  }
  return answerFromFrontDoor(res, {
    hostId,
    userId,
    kind: "app-archive",
    args: { slug },
    requestId: requestIdFrom((req.body as { requestId?: unknown } | undefined)?.requestId),
    operation: "app_archive_request",
  });
});

export default router;
