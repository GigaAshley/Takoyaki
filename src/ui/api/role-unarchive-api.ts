import { UnarchiveError, sendUnarchive, type UnarchiveFailureReason, type UnarchiveOutcome } from "@/api/identity-unarchive-api";

export { UnarchiveError, type UnarchiveFailureReason };

/**
 * Un-archive a role, through its machine's front door in the order this
 * machine's changes were clicked. Rejects with an UnarchiveError: its reason
 * is name_collision / archive_not_found / refused (the machine's reason as
 * the message) / connection_lost.
 */
export function unarchiveRole(
  hostId: number,
  roleName: string,
  onStillWorking?: () => void,
): Promise<{ ok: true; outcome: UnarchiveOutcome }> {
  return sendUnarchive(hostId, `/roles/${encodeURIComponent(roleName)}/unarchive`, { hostId }, "un-archive role", undefined, onStillWorking);
}
