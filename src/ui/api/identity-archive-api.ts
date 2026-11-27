import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

/**
 * Archive an agent. The machine's front door takes it in the order this
 * machine's changes were clicked (sent one after another) and claims it at
 * once — from then on it's gone everywhere and stopped; the machine finishes
 * the rest in the background. Resolves with the machine's answer (done, or
 * `done: false` if it was still waiting its turn after asking again); a
 * refusal rejects with a MachineChangeError carrying the machine's reason.
 */
export function archiveIdentity(
  hostId: number,
  identityKey: string,
  onStillWorking?: () => void,
): Promise<MachineChangeAnswer<unknown>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      { method: "post", url: `/identities/${encodeURIComponent(identityKey)}/archive`, body: { hostId } },
      "archive the agent",
      { followUp: "status", onStillWorking },
    ),
  );
}
