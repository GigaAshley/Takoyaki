import type { AuthenticatedRequest } from "../../../types/index.js";
import type { RequestHandler, Router } from "express";
import { databaseLogger } from "../../utils/logger.js";
import { requireRecentAuth } from "../../utils/recent-auth.js";
import { db, DatabaseSaveTrigger } from "../db/index.js";

// An admin removing a host entry another user owns — the owner's own delete
// (DELETE /db/host/:id) only ever reaches the caller's rows. Clears the same
// things the owner's delete does, in one transaction.

const STATS_SERVER_URL = "http://localhost:30005";

interface UserAdminHostRoutesDeps {
  requireAdmin: RequestHandler;
}

const CLEANUP_STATEMENTS = [
  "DELETE FROM file_manager_recent WHERE host_id = ?",
  "DELETE FROM file_manager_pinned WHERE host_id = ?",
  "DELETE FROM file_manager_shortcuts WHERE host_id = ?",
  "DELETE FROM transfer_recent WHERE ? IN (source_host_id, dest_host_id)",
  "DELETE FROM command_history WHERE host_id = ?",
  "DELETE FROM ssh_credential_usage WHERE host_id = ?",
  "DELETE FROM recent_activity WHERE host_id = ?",
  "DELETE FROM session_recordings WHERE host_id = ?",
  "DELETE FROM host_access WHERE host_id = ?",
];

export function registerUserAdminHostRoutes(
  router: Router,
  { requireAdmin }: UserAdminHostRoutesDeps,
): void {
  /**
   * @openapi
   * /users/{id}/hosts/{hostId}:
   *   delete:
   *     summary: Remove a host another user owns (admin only)
   *     description: |
   *       Deletes the user's host entry and what hangs off it (file-manager
   *       recents, pins and shortcuts, transfers, command history, credential
   *       usage, recent activity, session recordings, access given to others).
   *       The machine itself is untouched. Needs a session that confirmed it's
   *       you in the last 10 minutes; access keys are refused.
   *     tags:
   *       - Users
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Host removed.
   *       400:
   *         description: Invalid host id.
   *       403:
   *         description: Not an admin, or REAUTH_REQUIRED / REAUTH_UNAVAILABLE.
   *       404:
   *         description: That user has no host with that id.
   *       500:
   *         description: Failed to remove the host.
   */
  router.delete("/:id/hosts/:hostId", requireAdmin, requireRecentAuth, async (req, res) => {
    const adminId = (req as AuthenticatedRequest).userId;
    const targetId = String(req.params.id);
    const hostId = Number(req.params.hostId);

    if (!Number.isInteger(hostId) || hostId <= 0) {
      return res.status(400).json({ error: "Invalid host id" });
    }

    try {
      const row = db.$client
        .prepare(
          "SELECT h.id, h.name, h.ip, u.username FROM ssh_data h JOIN users u ON u.id = h.user_id WHERE h.id = ? AND h.user_id = ?",
        )
        .get(hostId, targetId) as
        | { id: number; name: string | null; ip: string | null; username: string }
        | undefined;
      if (!row) {
        databaseLogger.warn("Admin host remove: not found", {
          operation: "admin_host_remove_not_found",
          adminId,
          targetUserId: targetId,
          hostId,
        });
        return res.status(404).json({ error: "That user has no such host" });
      }

      db.$client.transaction(() => {
        for (const sql of CLEANUP_STATEMENTS) {
          db.$client.prepare(sql).run(hostId);
        }
        db.$client
          .prepare("DELETE FROM ssh_data WHERE id = ? AND user_id = ?")
          .run(hostId, targetId);
      })();

      try {
        await DatabaseSaveTrigger.forceSave("admin_host_remove");
      } catch (saveErr) {
        databaseLogger.warn("Admin host remove: force-save failed", {
          operation: "admin_host_remove_save_failed",
          adminId,
          targetUserId: targetId,
          hostId,
          error: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
      }

      databaseLogger.warn("Admin removed a user's host", {
        operation: "admin_host_remove",
        adminId,
        targetUserId: targetId,
        targetUsername: row.username,
        hostId,
        hostName: row.name ?? row.ip,
      });

      // Stop stats polling for it, as the owner's delete does.
      try {
        const axios = (await import("axios")).default;
        await axios.post(
          `${STATS_SERVER_URL}/host-deleted`,
          { hostId },
          {
            headers: {
              Authorization: req.headers.authorization || "",
              Cookie: req.headers.cookie || "",
            },
            timeout: 5000,
          },
        );
      } catch (err) {
        databaseLogger.warn("Admin host remove: stats notify failed", {
          operation: "admin_host_remove_stats_notify_failed",
          hostId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      res.json({ message: "Host removed" });
    } catch (err) {
      databaseLogger.error("Admin host remove failed", err, {
        operation: "admin_host_remove_failed",
        adminId,
        targetUserId: targetId,
        hostId,
      });
      res.status(500).json({ error: "Failed to remove the host" });
    }
  });
}
