/**
 * Role archive, through the machine's front door (fleet-change).
 *
 * GET /roles/:name/archive-preflight?hostId=  — who archiving the role would
 *   take, as the machine sees it right now (role-contents). The confirm lists
 *   exactly these agents.
 *   → 200 { ok: true, requestId, result: { role, displayName, agents: [{ name, displayName, task }] } }
 *   → 409 { error, code: "not_found" }  not a live role (or already being archived)
 *
 * POST /roles/:name/archive  body: { hostId, expected: { agents: [names] }, requestId? }
 *   Claims the role and every agent holding it, in arrival order with the
 *   machine's other changes; the supervisor finishes them in the background
 *   (agents first, then the role's folder). Refused — nothing archived — when
 *   the agents holding it are no longer the ones the user confirmed
 *   (contents_changed, with the current list as result), when an agent holding
 *   it is still being un-archived (agent_returning), or when an archived role
 *   of the same name is in the way.
 *   → 200 { ok: true, requestId, result: { role, claimed }, finishing? }
 *   → 202 { pending: true, requestId }
 *   → 409 { error, code, result? }
 *   → 409 { code: "instance_wide" }  a shared role comes off machines through its machine list
 *   → 503 { code: "updating" }  the machine's update hasn't finished
 *   → 400 bad hostId / name / expected; 404 not the caller's host; 504 unreachable
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import { getInstanceWide, syncedMachineForHostRow } from "../../instance-wide/production.js";
import express from "express";
import type { Request, Response } from "express";
import { AuthManager } from "../../utils/auth-manager.js";
import { resolveHostById } from "../../ssh/host-resolver.js";
import { ROLE_NAME_PATTERN } from "../../utils/role-name-pattern.js";
import { requestIdFrom } from "../../fleet-change/front-door.js";
import { answerFromFrontDoor, parseHostId } from "../../fleet-change/front-door-route.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

const AGENT_NAME_RE = /^[a-z0-9_-]{1,64}$/;

router.get("/:name/archive-preflight", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const hostId = parseHostId(req.query.hostId);
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
    kind: "role-contents",
    args: { name },
    requestId: requestIdFrom(undefined),
    operation: "role_archive_preflight",
    totalS: 30,
  });
});

router.post("/:name/archive", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const body = (req.body ?? {}) as { hostId?: unknown; expected?: unknown; requestId?: unknown };
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
  const agents = (body.expected as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(agents) || !agents.every((a) => typeof a === "string" && AGENT_NAME_RE.test(a))) {
    return res.status(400).json({ error: "expected.agents (the agents the user confirmed) is required" });
  }

  // A shared role that goes to this machine would be restored by the sync
  // if archived here; it comes off machines via its machine list or
  // "Delete from every machine". On a machine it doesn't go to, a
  // same-named role is the machine's own.
  const engine = getInstanceWide();
  if (engine) {
    const host = await resolveHostById(hostId, userId);
    if (!host) return res.status(404).json({ error: "Host not found" });
    const machine = await syncedMachineForHostRow(hostId, async () => (host as { username?: unknown }).username);
    if (machine && (await engine.isSharedOn("role", name, machine.machineId))) {
      return res.status(409).json({
        error: "this role is shared — take this machine off its list instead",
        code: "instance_wide",
      });
    }
  }

  return answerFromFrontDoor(res, {
    hostId,
    userId,
    kind: "role-archive",
    args: { name, expected: { agents } },
    requestId: requestIdFrom(body.requestId),
    operation: "role_archive_request",
  });
});

export default router;
