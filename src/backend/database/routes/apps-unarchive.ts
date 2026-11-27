/**
 * POST /apps/:hostId/:slug/unarchive  body: { requestId?: string }
 *
 * Un-archive a sidebar app: a request to the machine's front door
 * (fleet-change app-unarchive), carried out in arrival order with the
 * machine's other changes — the folder moves back and its units are put back
 * on the port it had. Refused when another app now holds that port, or its
 * saved units are missing.
 *
 *   → 200 { ok: true, outcome: "restored" | "pending", requestId }
 *   → 409 { reason: "archive_not_found" | "name_collision" | "refused", message, code }
 *   → 500 { error, code }  back in place but couldn't be started
 *   → 503 { code: "updating" }  the machine's update hasn't finished
 *   → 400 bad hostId / slug; 404 not the caller's host; 504 unreachable
 *
 * hostId is in the path, as for every app route.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { APP_SLUG_RE } from "../../claude-session/identity-artifact-reader.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId, unarchiveAnswer } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.post("/:hostId/:slug/unarchive", authenticateJWT, async (req: Request, res: Response) => {
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
    kind: "app-unarchive",
    args: { slug },
    requestId: requestIdFrom((req.body as { requestId?: unknown } | undefined)?.requestId),
    operation: "app_unarchive_request",
    totalS: 30,
    answer: unarchiveAnswer,
  });
});

export default router;
