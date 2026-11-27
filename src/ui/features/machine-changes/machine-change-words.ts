import { kitAlert, kitConfirm } from "@/components/kit/dialogs";
import { markNoticeSeen, reasonSentence } from "@/api/machine-changes-api";
import type { MachineChange } from "@/state/machine-changes-store";

// ─── How the sidebar words a machine's open changes and notices ──────────────

/** What the change does, as a verb: "Couldn't <verb>". */
export function verbFor(c: MachineChange): string {
  switch (c.kind) {
    case "agent-pin":
      return c.to?.pinned ? "pin" : "unpin";
    case "agent-project":
    case "app-move":
    case "project-move":
      return "move";
    case "agent-edit":
      return "change";
    case "project-rename":
      return "rename";
    case "project-create":
      return "make";
    case "agent-archive":
    case "app-archive":
    case "project-archive":
    case "role-archive":
      return "archive";
    case "agent-unarchive":
    case "app-unarchive":
    case "role-unarchive":
      return "bring back";
    default:
      return "change";
  }
}

/** Where a waiting move ends up, in words: "Moving to Research…". */
export function movingLabel(c: MachineChange, projectName: (slug: string) => string | null): string {
  const to = c.to ?? {};
  if (to.hidden) return "Moving…";
  const named = (slug: string | null | undefined, otherwise: string) =>
    `Moving to ${slug ? (projectName(slug) ?? slug) : otherwise}…`;
  switch (c.kind) {
    case "agent-pin":
      return to.pinned ? "Moving to Pinned…" : "Moving to Conversations…";
    case "agent-project":
      return named(to.project, "Conversations");
    case "app-move":
      return named(to.project, "Apps");
    case "project-move":
      return named(to.parent, "the top level");
    default:
      return "Moving…";
  }
}

/** A failure mark's short label on its row. */
export function failureLabel(c: MachineChange): string {
  return c.state === "unfiled" ? "Not filed" : `Couldn't ${verbFor(c)}`;
}

function noticeTitle(c: MachineChange, thing: string): string {
  if (c.state === "unfiled") return `${thing} is in Conversations`;
  return `Couldn't ${verbFor(c)} ${thing}`;
}

function noticeBody(c: MachineChange): string {
  const why = c.reason ? reasonSentence(c.reason) : "";
  if (c.state === "unfiled") return why ? `${why} It was left in Conversations.` : "It was left in Conversations.";
  return why || "The machine didn't say why.";
}

/**
 * A failure mark tapped: the full reason, and Dismiss — which clears it on every one of
 * this person's devices. Keep leaves it on the row.
 */
export async function openNoticeOnRow(hostId: number | string, c: MachineChange, thing: string): Promise<void> {
  const dismiss = await kitConfirm({
    title: noticeTitle(c, thing),
    body: noticeBody(c),
    confirmLabel: "Dismiss",
    cancelLabel: "Keep",
  });
  if (!dismiss) return;
  try {
    await markNoticeSeen(hostId, c.id);
    console.info({ operation: "machine_notice_dismissed", hostId, requestId: c.id, kind: c.kind });
  } catch (err) {
    console.warn({
      operation: "machine_notice_dismiss_failed",
      hostId,
      requestId: c.id,
      errMessage: err instanceof Error ? err.message : String(err),
    });
    void kitAlert({ title: "Couldn't dismiss it", body: "Try again in a moment." });
  }
}

/** A notice with no row to mark, as a one-time pop-up (already claimed by this device). */
export function showNoticePopup(c: MachineChange, thing: string): Promise<void> {
  return kitAlert({ title: noticeTitle(c, thing), body: noticeBody(c) });
}

/** One archive's stuck clean-up (one or more of what it took), as a one-time pop-up. */
export function showStuckPopup(changes: readonly MachineChange[], names: readonly string[]): Promise<void> {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const reasons = Array.from(new Set(changes.map((c) => c.reason).filter((r): r is string => !!r)));
  const why = reasons.map(reasonSentence).join(" ");
  return kitAlert({
    title: `Archiving ${list} is still finishing`,
    body: `${why ? `${why} ` : ""}It keeps retrying on its own.`,
  });
}
