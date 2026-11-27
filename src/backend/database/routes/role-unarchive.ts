/**
 * POST /roles/:name/unarchive  body: { hostId: number, requestId?: string }
 *
 * Un-archive a role: a request to the machine's front door (fleet-change
 * role-unarchive), carried out in arrival order with the machine's other
 * changes — the folder moves back to ~/fleet/roles/. Agents archived with it
 * stay archived until un-archived themselves.
 *
 *   → 200 { ok: true, outcome: "restored" | "pending", requestId }
 *   → 409 { reason: "archive_not_found" | "name_collision" | "refused", message, code }
 *   → 503 { code: "updating" }  the machine's update hasn't finished
 *   → 400 bad hostId / name; 404 not the caller's host; 504 unreachable
 *
 * Mounted in database.ts after app.use("/roles", roleArchiveRoutes); the
 * sub-paths are distinct.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { ROLE_NAME_PATTERN } from "../../utils/role-name-pattern.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId, unarchiveAnswer } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.post("/:name/unarchive", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = (req.body ?? {}) as { hostId?: unknown; requestId?: unknown };
  if (body.hostId === undefined || body.hostId === null || body.hostId === "") {
    return res.status(400).json({ error: "hostId is required" });
  }
  const hostId = parseHostId(body.hostId);
  if (hostId === null) {
    return res.status(400).json({ error: "hostId must be a positive integer" });
  }
  const name = String(req.params.name ?? "");
  if (!ROLE_NAME_PATTERN.test(name)) {
    return res.status(400).json({ error: "role name must match [a-z0-9-]" });
  }
  return answerFromFrontDoor(res, {
    hostId,
    userId,
    kind: "role-unarchive",
    args: { name },
    requestId: requestIdFrom(body.requestId),
    operation: "role_unarchive_request",
    totalS: 30,
    answer: unarchiveAnswer,
  });
});

export default router;
