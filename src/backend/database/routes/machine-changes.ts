/**
 * GET /machine-changes/:hostId/:requestId — where a change sent to a
 * machine's front door is now.
 *
 * A move or archive still waiting or running when its route answered comes
 * back as 202 { pending, requestId }; the client asks here, by that id, for
 * its real outcome. Waits up to the front door's usual wait for it to finish.
 *
 *   → 200 { ok, requestId, result }   done
 *   → 202 { pending: true, requestId } still waiting or running
 *   → 409 / 500 { error, code }        refused / failed, with the machine's reason
 *   → 404 unknown host, or the machine has no such request
 *   → 503 { code: "updating" }         the machine's update hasn't finished
 *   → 504 host unreachable
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import { HttpError, withHost } from "../../sharing/host-conn.js";
import { REQUEST_ID_RE, frontDoorHttp, frontDoorStatus } from "../../fleet-change/front-door.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.get("/:hostId/:requestId", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const hostId = Number(req.params.hostId);
  if (!Number.isInteger(hostId) || hostId <= 0) {
    return res.status(400).json({ error: "hostId must be a positive integer" });
  }
  const requestId = String(req.params.requestId);
  if (!REQUEST_ID_RE.test(requestId)) {
    return res.status(400).json({ error: "invalid request id" });
  }
  try {
    const outcome = await withHost(hostId, userId, (conn) => frontDoorStatus(conn, requestId));
    if (outcome === null) return res.status(404).json({ error: "no such request on this machine" });
    const { status, body } = frontDoorHttp(outcome);
    return res.status(status).json(body);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    databaseLogger.error("machine change status failed", {
      operation: "machine_change_status_failed",
      hostId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "couldn't ask the machine" });
  }
});

export default router;
