import { useCallback } from "react";
import type { MouseEvent, KeyboardEvent } from "react";
import { useProjects } from "@/state/conversation-store";
import type { MachineMark } from "@/state/machine-changes-store";
import { failureLabel, movingLabel, openNoticeOnRow } from "./machine-change-words";

/**
 * The small mark at the end of a sidebar row (agent, project header, app) for a change
 * its machine hasn't finished — "Moving to Research…", "Archiving…" — or one of this
 * person's that didn't happen ("Couldn't move"; tap for why, and to dismiss it).
 * Styles: pretty-conversations.css (.pv-machine-mark).
 */
export function MachineChangeMark({
  mark,
  hostId,
  thing,
}: {
  mark: MachineMark;
  hostId: number | string | null | undefined;
  /** What the row is, for the notice's title ("Finch", "Research"). */
  thing: string;
}) {
  const projects = useProjects();
  const projectName = useCallback(
    (slug: string) =>
      projects.find((p) => p.slug === slug && String(p.hostId) === String(hostId))?.displayName ?? null,
    [projects, hostId],
  );
  const open = useCallback(
    (e: MouseEvent | KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (mark?.kind === "failed" && hostId !== null && hostId !== undefined) {
        void openNoticeOnRow(hostId, mark.change, thing);
      }
    },
    [mark, hostId, thing],
  );
  if (!mark) return null;
  if (mark.kind === "failed") {
    return (
      <button
        type="button"
        className="pv-machine-mark pv-machine-mark--failed"
        data-testid="pv-machine-mark-failed"
        title={mark.change.reason ?? undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") open(e);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        draggable={false}
      >
        {failureLabel(mark.change)}
      </button>
    );
  }
  return (
    <span
      className={`pv-machine-mark pv-machine-mark--${mark.kind}`}
      data-testid={`pv-machine-mark-${mark.kind}`}
    >
      {mark.kind === "archiving" ? "Archiving…" : movingLabel(mark.change, projectName)}
    </span>
  );
}
