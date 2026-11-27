import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

/**
 * Archive a sidebar app, through the machine's front door in the order this
 * machine's changes were clicked. Resolves with the machine's answer; a
 * refusal or failure rejects with a MachineChangeError carrying its reason.
 */
export function archiveApp(
  hostId: number,
  slug: string,
  onStillWorking?: () => void,
): Promise<MachineChangeAnswer<unknown>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      { method: "post", url: `/apps/${hostId}/${encodeURIComponent(slug)}/archive`, body: {} },
      "archive the app",
      { followUp: "status", onStillWorking },
    ),
  );
}
