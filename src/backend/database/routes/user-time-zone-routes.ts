/**
 * Person time zone — the signed-in person's own zone (utils/person-time-zone.ts).
 *
 *   GET    /users/me/time-zone          → { timeZone: string | null, pinned }
 *   POST   /users/me/time-zone/browser  → same, after the browser's report
 *                                         (body: { timeZone })
 *   PUT    /users/me/time-zone/pin      → same, pinned (body: { timeZone })
 *   DELETE /users/me/time-zone/pin      → same, following the browser again
 *                                         (body: { browserTimeZone? })
 *
 * The browser report is sent only when the browser's zone differs from the
 * saved one; the server still ignores it while pinned or when it's plain UTC
 * and answers with what's saved, so the browser learns it has nothing to send.
 * A changed zone reaches the person's machines through the people list, which
 * the substrate orchestrator re-checks every retry tick.
 */

import type { AuthenticatedRequest } from "../../../types/index.js";
import type { RequestHandler, Response, Router } from "express";
import { authLogger } from "../../utils/logger.js";
import { DatabaseSaveTrigger } from "../../utils/database-save-trigger.js";
import {
  applyBrowserTimeZone,
  getPersonTimeZone,
  isValidTimeZone,
  pinTimeZone,
  unpinTimeZone,
  type PersonTimeZone,
  type TimeZoneChange,
} from "../../utils/person-time-zone.js";

export type MyTimeZone = { timeZone: string | null; pinned: boolean };

function toWire(tz: Exclude<PersonTimeZone, { status: "no_such_person" }>): MyTimeZone {
  return tz.status === "set"
    ? { timeZone: tz.timeZone, pinned: tz.pinned }
    : { timeZone: null, pinned: false };
}

async function persist(userId: string, reason: string): Promise<void> {
  // Non-fatal: a failed save leaves the change in RAM and it lands on disk
  // with the next save.
  try {
    await DatabaseSaveTrigger.forceSave(reason);
  } catch (saveError) {
    authLogger.error("Failed to persist time zone change to disk", saveError, {
      operation: "user_time_zone_save_failed",
      userId,
    });
  }
}

/** Answers a change: 404 for a missing person, else saves when changed and
 *  replies with the zone as it now stands. */
async function answerChange(
  res: Response,
  userId: string,
  operation: string,
  change: TimeZoneChange,
): Promise<void> {
  if (change.result.status === "no_such_person") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const wire = toWire(change.result);
  if (change.changed) {
    await persist(userId, operation);
    authLogger.info("Person time zone changed", {
      operation,
      userId,
      timeZone: wire.timeZone,
      pinned: wire.pinned,
    });
  }
  res.json(wire);
}

export function registerUserTimeZoneRoutes(
  router: Router,
  authenticateJWT: RequestHandler,
): void {
  /**
   * @openapi
   * /users/me/time-zone:
   *   get:
   *     summary: Get the current user's time zone
   *     description: The caller's IANA time zone (null when not known yet) and whether they pinned it.
   *     tags:
   *       - Users
   *     responses:
   *       200:
   *         description: The caller's time zone.
   *       404:
   *         description: User not found.
   */
  router.get("/me/time-zone", authenticateJWT, async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const tz = await getPersonTimeZone(userId);
      if (tz.status === "no_such_person") return res.status(404).json({ error: "User not found" });
      res.json(toWire(tz));
    } catch (err) {
      authLogger.error("Failed to get time zone", err, { operation: "user_time_zone_get_failed", userId });
      res.status(500).json({ error: "Failed to get time zone" });
    }
  });

  /**
   * @openapi
   * /users/me/time-zone/browser:
   *   post:
   *     summary: Report the browser's time zone
   *     description: The browser the caller is using reports its IANA time zone. It becomes the saved zone unless the zone is pinned or the browser is in plain UTC. Answers with the zone as it now stands.
   *     tags:
   *       - Users
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               timeZone:
   *                 type: string
   *     responses:
   *       200:
   *         description: The caller's time zone as it now stands.
   *       400:
   *         description: timeZone missing or not a known time zone.
   *       404:
   *         description: User not found.
   */
  router.post("/me/time-zone/browser", authenticateJWT, async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { timeZone } = req.body ?? {};
    if (!isValidTimeZone(timeZone)) {
      return res.status(400).json({ error: "timeZone must be a known IANA time zone" });
    }
    try {
      await answerChange(res, userId, "user_time_zone_followed_browser", await applyBrowserTimeZone(userId, timeZone));
    } catch (err) {
      authLogger.error("Failed to apply browser time zone", err, { operation: "user_time_zone_browser_failed", userId });
      res.status(500).json({ error: "Failed to update time zone" });
    }
  });

  /**
   * @openapi
   * /users/me/time-zone/pin:
   *   put:
   *     summary: Pin the current user's time zone
   *     description: Sets the caller's time zone and stops browsers from changing it.
   *     tags:
   *       - Users
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               timeZone:
   *                 type: string
   *     responses:
   *       200:
   *         description: The pinned time zone.
   *       400:
   *         description: timeZone missing or not a known time zone.
   *       404:
   *         description: User not found.
   */
  router.put("/me/time-zone/pin", authenticateJWT, async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { timeZone } = req.body ?? {};
    if (!isValidTimeZone(timeZone)) {
      return res.status(400).json({ error: "timeZone must be a known IANA time zone" });
    }
    try {
      await answerChange(res, userId, "user_time_zone_pinned", await pinTimeZone(userId, timeZone));
    } catch (err) {
      authLogger.error("Failed to pin time zone", err, { operation: "user_time_zone_pin_failed", userId });
      res.status(500).json({ error: "Failed to pin time zone" });
    }
  });

  /**
   * @openapi
   * /users/me/time-zone/pin:
   *   delete:
   *     summary: Unpin the current user's time zone
   *     description: The caller's time zone follows their browser again; the browser they unpin from (browserTimeZone) takes over at once unless it is plain UTC.
   *     tags:
   *       - Users
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               browserTimeZone:
   *                 type: string
   *     responses:
   *       200:
   *         description: The caller's time zone as it now stands.
   *       400:
   *         description: browserTimeZone is not a known time zone.
   *       404:
   *         description: User not found.
   */
  router.delete("/me/time-zone/pin", authenticateJWT, async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const raw = (req.body ?? {}).browserTimeZone;
    if (raw !== undefined && raw !== null && !isValidTimeZone(raw)) {
      return res.status(400).json({ error: "browserTimeZone must be a known IANA time zone" });
    }
    try {
      await answerChange(
        res,
        userId,
        "user_time_zone_unpinned",
        await unpinTimeZone(userId, typeof raw === "string" ? raw : null),
      );
    } catch (err) {
      authLogger.error("Failed to unpin time zone", err, { operation: "user_time_zone_unpin_failed", userId });
      res.status(500).json({ error: "Failed to unpin time zone" });
    }
  });
}
