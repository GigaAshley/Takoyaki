import { UnarchiveError, sendUnarchive, type UnarchiveFailureReason, type UnarchiveOutcome } from "@/api/identity-unarchive-api";

// Re-export so downstream consumers can import from either module.
export { UnarchiveError, type UnarchiveFailureReason };

/**
 * Un-archive a sidebar app, through its machine's front door in the order
 * this machine's changes were clicked; it comes back on the port it had.
 * Rejects with an UnarchiveError: name_collision / archive_not_found /
 * refused (the machine's reason as the message — e.g. its port is now taken)
 * / connection_lost.
 */
export function unarchiveApp(
  hostId: number,
  slug: string,
  onStillWorking?: () => void,
): Promise<{ ok: true; outcome: UnarchiveOutcome }> {
  return sendUnarchive(hostId, `/apps/${hostId}/${encodeURIComponent(slug)}/unarchive`, {}, "un-archive app", undefined, onStillWorking);
}
