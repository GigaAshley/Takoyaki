/**
 * PUT /identities/:key/pinned  body: { hostId: number, pinned: boolean, requestId?: string }
 *   → 200 { ok: true, pinned, requestId, result: { name, pinned, previousProject } }
 *
 * Pin or unpin one agent, through the machine's front door (fleet-change agent-pin), in turn
 * with the machine's other changes. A per-agent change, never the whole set of pins: a stale
 * tab can't unpin what another just pinned.
 *
 * Pinned and in a project are one or the other: pinning takes the agent out of its project in
 * the same change (open sidebars are told with session-project-changed). The inverse lives in
 * session-project-write.ts. Other tabs learn the pin itself from the fleet-status sweep.
 *
 *   → 202 still waiting its turn; 503 { code: "updating" }
 *   → 409 { error, code }: being_archived, not_found, archived
 *   → 400 bad hostId / key / pinned; 404 not the caller's host; 504 unreachable
 *
 * Mounted in database.ts BEFORE the generic /identities router (same discipline as
 * no-dormancy / archive).
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { databaseLogger } from "../../utils/logger.js";
import { IDENTITY_KEY_RE } from "../../claude-session/identity-artifact-reader.js";
import { getSubscriptionRegistry } from "../../fleet-status/subscription-registry.js";
import { frontDoorHttp, requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

router.put(
  "/:key/pinned",
  authenticateJWT,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const body = (req.body ?? {}) as { hostId?: unknown; pinned?: unknown; requestId?: unknown };

    const rawHostId = body.hostId;
    if (rawHostId === undefined || rawHostId === null || rawHostId === "") {
      return res.status(400).json({ error: "hostId is required" });
    }
    const hostId = parseHostId(rawHostId);
    if (hostId === null) {
      return res.status(400).json({ error: "hostId must be a positive integer" });
    }
    if (typeof body.pinned !== "boolean") {
      return res.status(400).json({ error: "pinned must be a boolean" });
    }
    const pinned = body.pinned;
    const key = String(req.params.key ?? "");
    if (!key || !IDENTITY_KEY_RE.test(key)) {
      return res.status(400).json({ error: "identity key must match [a-z0-9_-]{1,64}" });
    }

    return answerFromFrontDoor(res, {
      hostId,
      userId,
      kind: "agent-pin",
      args: { name: key, pinned },
      requestId: requestIdFrom(body.requestId),
      operation: "identity_pin_set",
      answer: (outcome) => {
        if (outcome.state !== "done") return null;
        const { status, body: b } = frontDoorHttp(outcome);
        return { status, body: { ...b, pinned } };
      },
      onDone: async (_conn, outcome) => {
        const previous = (outcome.result as { previousProject?: unknown } | null)?.previousProject;
        if (typeof previous !== "string") return;
        databaseLogger.info("identity pin cleared project", {
          operation: "identity_pin_cleared_project",
          userId,
          hostId,
          identityKey: key,
          previousProject: previous,
        });
        getSubscriptionRegistry()?.publishSessionProjectChanged(key, hostId, null);
      },
    });
  },
);

router.use(
  (
    err: Error,
    _req: Request,
    res: Response,
    _next: express.NextFunction,
  ) => {
    return res
      .status(500)
      .json({ error: err?.message ?? "identity-pin route error" });
  },
);

export default router;
