// ─── archive-identity-pane.ts ──────────────────────────────────────────────
// Archive the identity behind an open pane: confirm, close the pane, grey
// the sidebar row with "Archiving…", then fire the archive; the row goes once
// the machine has taken it. Shared by the
// identity badge's menu Archive item and the badge drop lane's archive zone
// so both read the same confirmation and roll back the same way. The agent's
// active wake-ups are looked up while the confirm is open — Archive waits for
// them — so it can name the ones that would stop (archive-wakeup-check.ts).

import { announceAgentArchived } from "@/features/archived-view/archived-identity";
import { applyIdentityChange } from "@/state/identities-store";
import { markArchivingHere } from "@/state/machine-changes-store";
import {
  markPendingArchive,
  removeFleetSession,
  getFleetSessionsSnapshot,
} from "@/state/conversation-store";
import { toast } from "sonner";
import { archiveIdentity } from "@/api/identity-archive-api";
import { MachineChangeError, reasonSentence, whenMachineDone } from "@/api/machine-changes-api";
import { kitAlert, kitConfirm } from "@/components/kit";
import {
  ARCHIVE_AGENT_BODY,
  checkActiveWakeups,
  claimArchivePrompt,
  releaseArchivePrompt,
  singleAgentArchiveBody,
} from "./archive-wakeup-check";

export function confirmAndArchiveIdentityPane(args: {
  hostId: number;
  identityKey: string;
  /** Sidebar-row label for the confirm copy: task, else displayName, else key. */
  label: string;
  closePane: () => void;
}): void {
  void confirmThenArchive(args);
}

async function confirmThenArchive(args: {
  hostId: number;
  identityKey: string;
  label: string;
  closePane: () => void;
}): Promise<void> {
  const { hostId, identityKey, label, closePane } = args;
  if (!claimArchivePrompt(hostId, identityKey)) return;
  let ok: boolean;
  try {
    // The confirm opens at once; Archive waits for the check, which then
    // fills in the wake-up warning.
    ok = await kitConfirm({
      title: `Archive "${label}"?`,
      body: ARCHIVE_AGENT_BODY,
      ready: checkActiveWakeups(hostId, identityKey).then((check) => ({ body: singleAgentArchiveBody(check) })),
      confirmLabel: "Archive",
      destructive: true,
    });
  } finally {
    releaseArchivePrompt(hostId, identityKey);
  }
  if (!ok) return;
  // Close the visible pane BEFORE the API call (mirrors the panel's
  // handleArchive).
  closePane();
  // The sidebar row stays, greyed with "Archiving…", until the machine has taken it.
  const clearMark = markArchivingHere(hostId, "agent", identityKey);
  void (async () => {
    try {
      const answer = await archiveIdentity(hostId, identityKey, () => {
        toast(`Still archiving "${label}"`, { description: "The machine is still working on it." });
      });
      const ended = await whenMachineDone(hostId, answer);
      clearMark();
      // Refused after this stopped asking: the row stays, with the reason on it.
      if (ended === "failed") {
        console.info({ operation: "identity_archive_refused_later", hostId, identityKey });
        return;
      }
      // Taken: off the sidebar now — markPendingArchive FIRST so a racing fleet-status
      // upsert is silent-dropped rather than re-inserting the row.
      // (Unless the machine's `gone` already took it: a mark set then is never cleared.)
      if (getFleetSessionsSnapshot().some((fs) => fs.hostId === hostId && fs.sessionName === identityKey)) {
        markPendingArchive(hostId, identityKey);
      }
      removeFleetSession(hostId, identityKey);
      applyIdentityChange(null, identityKey, hostId);
      // Archived: every other open copy in this window closes too.
      announceAgentArchived(hostId, identityKey);
    } catch (err) {
      clearMark();
      console.warn({
        operation: "identity_archive_failed",
        hostId,
        identityKey,
        errMessage: err instanceof Error ? err.message : String(err),
      });
      void kitAlert({
        title: "Couldn't archive",
        body: err instanceof MachineChangeError ? reasonSentence(err.message) : err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
