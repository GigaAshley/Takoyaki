/**
 * /identities/:key/condense — the user pressed Compact conversation. Asks the
 * machine's front door (fleet-change agent-compact), the same way an agent asks
 * for its own compaction: refused while the agent's archive is claimed, and a
 * second press while one is waiting is the same compaction. Once accepted the
 * agent-supervisor carries it out on its next tick (waking a dormant agent
 * through its inbox, waiting for an awake one to be at rest), then delivers a
 * "Compaction done" event so the agent takes a turn.
 *
 * POST /identities/:key/condense  body: { hostId: number, guidance?: string, requestId?: string }
 *   → 200 { ok: true, requestId, result }   accepted
 *   → 202 { pending: true }                 still waiting its turn (it will be carried out)
 *   → 409 { error, code }                   being_archived, archived, not_found
 *   → 503 { code: "updating" }              the machine's update hasn't landed yet
 *   → 400 bad hostId / key; 404 not the caller's host; 504 unreachable
 *
 * `guidance` is whatever the user had typed in the composer — passed to the
 * compaction as what the summary should keep. Whitespace (newlines included)
 * is collapsed, control characters dropped, and it is cut to fit
 * GUIDANCE_MAX_BYTES; empty means none. The guidance text is never logged.
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

/**
 * The machine refuses more (fleet-change COMPACT_GUIDANCE_MAX): Claude Code
 * takes a paste over 800 characters as pasted text, not the /compact command.
 */
export const GUIDANCE_MAX_BYTES = 700;

export function normalizeGuidance(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Whitespace (newlines included) collapses to single spaces; other control
  // characters are dropped — an ESC sequence could end the supervisor's
  // bracketed paste early.
  const flat = raw.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // Cut on whole characters so a multi-byte one is never split.
  let out = "";
  let bytes = 0;
  for (const ch of flat) {
    bytes += Buffer.byteLength(ch, "utf8");
    if (bytes > GUIDANCE_MAX_BYTES) break;
    out += ch;
  }
  return out.trimEnd();
}

router.post(
  "/:key/condense",
  authenticateJWT,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;

    const body = (req.body ?? {}) as { hostId?: unknown; guidance?: unknown; requestId?: unknown };
    const rawHostId = body.hostId;
    if (rawHostId === undefined || rawHostId === null || rawHostId === "") {
      return res.status(400).json({ error: "hostId is required" });
    }
    const hostId = parseHostId(rawHostId);
    if (hostId === null) {
      return res.status(400).json({ error: "hostId must be a positive integer" });
    }

    const key = String(req.params.key ?? "");
    if (!key || !IDENTITY_KEY_RE.test(key)) {
      return res
        .status(400)
        .json({ error: "identity key must match [a-z0-9_-]{1,64}" });
    }

    const guidance = normalizeGuidance(body.guidance);
    return answerFromFrontDoor(res, {
      hostId,
      userId,
      kind: "agent-compact",
      args: guidance ? { name: key, guidance } : { name: key },
      requestId: requestIdFrom(body.requestId),
      operation: "identity_condense_requested",
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
      .json({ error: err?.message ?? "identity-condense route error" });
  },
);

export default router;
