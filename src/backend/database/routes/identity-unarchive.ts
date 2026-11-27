/**
 * POST /identities/:key/unarchive  body: { hostId: number, requestId?: string }
 *
 * Un-archive an agent: a request to the machine's front door (fleet-change
 * agent-unarchive), in arrival order with the machine's other changes. The
 * front door answers the quick checks straight away (the name is taken, a role
 * it holds is archived or being archived, it isn't in the archive) and
 * otherwise accepts it; the supervisor then brings the chat account back
 * (asking this backend's identity-reactivate agent service), moves the folder
 * back and finishes the request. An un-archive of an agent whose archive is
 * still being finished waits for that first. This route answers once the
 * machine has accepted it (the usual front-door wait); the client then asks
 * GET /machine-changes/:hostId/:requestId for the outcome, outside the
 * machine's click order, so the minute or so it takes holds nothing else up.
 *
 *   → 200 { ok: true, outcome: "restored", requestId }  back in the live tree
 *   → 200 { ok: true, outcome: "pending", requestId }   still coming back
 *   → 409 { reason: "archive_not_found" | "name_collision" | "identity_unreadable", message, code }
 *   → 409 { reason: "missing_roles", missingRoles, message, code }
 *   → 409 { reason: "refused", message, code }  refused by the machine, its reason as message
 *   → 503 { code: "updating" }  the machine's update hasn't finished
 *   → 400 bad hostId / key; 404 not the caller's host; 504 unreachable
 *
 * Mounted in database.ts after app.use("/identities", identityArchiveRoutes);
 * the sub-paths are distinct.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { IDENTITY_KEY_RE } from "../../claude-session/identity-artifact-reader.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId, unarchiveAnswer } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.post("/:key/unarchive", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = (req.body ?? {}) as { hostId?: unknown; requestId?: unknown };
  if (body.hostId === undefined || body.hostId === null || body.hostId === "") {
    return res.status(400).json({ error: "hostId is required" });
  }
  const hostId = parseHostId(body.hostId);
  if (hostId === null) {
    return res.status(400).json({ error: "hostId must be a positive integer" });
  }
  const key = String(req.params.key ?? "");
  if (!IDENTITY_KEY_RE.test(key)) {
    return res.status(400).json({ error: "identity key must match [a-z0-9_-]{1,64}" });
  }
  return answerFromFrontDoor(res, {
    hostId,
    userId,
    kind: "agent-unarchive",
    args: { name: key },
    requestId: requestIdFrom(body.requestId),
    operation: "identity_unarchive_request",
    answer: unarchiveAnswer,
  });
});

export default router;
