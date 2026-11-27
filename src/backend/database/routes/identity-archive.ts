/**
 * POST /identities/:key/archive  body: { hostId: number, requestId?: string }
 *
 * Archive an agent: a request to the machine's front door (fleet-change
 * agent-archive), carried out in arrival order with the machine's other
 * changes. The front door claims the agent and answers within a second or
 * two: from then on it's gone from every list, never launched, and stopped,
 * and anything else aimed at it is refused. The supervisor finishes the
 * archive in the background (chat account off, folder into the archive) and
 * retries until it's done; the done answer says what's still finishing.
 *
 *   → 200 { ok: true, requestId, result, finishing? }  claimed
 *   → 202 { pending: true, requestId }  still waiting its turn after the wait
 *   → 409 { error, code }  refused (e.g. an archived agent of the same name is in the way)
 *   → 503 { code: "updating" }  the machine's update after a deploy hasn't finished
 *   → 400 bad hostId / key; 404 not the caller's host; 504 host unreachable
 *
 * Mounted in database.ts BEFORE the generic /identities router so that
 * /identities/:key/archive resolves here.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { IDENTITY_KEY_RE } from "../../claude-session/identity-artifact-reader.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.post("/:key/archive", authenticateJWT, async (req: Request, res: Response) => {
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
    kind: "agent-archive",
    args: { name: key },
    requestId: requestIdFrom(body.requestId),
    operation: "identity_archive_request",
  });
});

export default router;
