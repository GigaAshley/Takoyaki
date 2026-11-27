import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

/** Where Move to sends an app: the sidebar, or a project on the app's machine. */
export type AppMoveDestination = { to: "sidebar" } | { to: "project"; project: string };

/**
 * project-scoped apps: ask the app's machine to move it. The machine's front
 * door carries the move out in the order this machine's changes were clicked
 * (sent one after another), and the answer is its real outcome: done, or a
 * MachineChangeError with the machine's reason. `onStillWorking` fires when
 * it's still under way after the server's wait; `done: false` means it still
 * was after asking again.
 */
export function requestAppMove(
  hostId: number,
  slug: string,
  dest: AppMoveDestination,
  onStillWorking?: () => void,
): Promise<MachineChangeAnswer<unknown>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      { method: "post", url: `/apps/${hostId}/${encodeURIComponent(slug)}/move`, body: { ...dest } },
      "move the app",
      { followUp: "status", onStillWorking },
    ),
  );
}
