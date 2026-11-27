import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

/** Who archiving a role takes, as its machine sees it right now. */
export type RoleArchiveContents = {
  role: string;
  displayName: string;
  agents: { name: string; displayName: string; task: string }[];
};

/**
 * Ask the role's machine who holds it — the list the archive confirm shows.
 * In this machine's click order, so it sees every change clicked before it.
 */
export async function getRoleArchivePreflight(hostId: number, roleName: string): Promise<RoleArchiveContents> {
  const answer = await inMachineOrder(hostId, () =>
    sendMachineChange<{ result: RoleArchiveContents }>(
      hostId,
      { method: "get", url: `/roles/${encodeURIComponent(roleName)}/archive-preflight?hostId=${hostId}` },
      "check who holds the role",
      { followUp: "none" },
    ),
  );
  if (!answer.done) throw new Error("the machine didn't answer in time; try again");
  return answer.result.result;
}

/**
 * Archive a role and the agents holding it — exactly `agents`, the ones the
 * user confirmed. Refused with code contents_changed (and the current list as
 * the error's result) when that's no longer who holds it; agent_returning
 * while one of them is still being un-archived.
 */
export function archiveRole(
  hostId: number,
  roleName: string,
  agents: string[],
  onStillWorking?: () => void,
): Promise<MachineChangeAnswer<unknown>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      { method: "post", url: `/roles/${encodeURIComponent(roleName)}/archive`, body: { hostId, expected: { agents } } },
      "archive the role",
      { followUp: "status", onStillWorking },
    ),
  );
}
