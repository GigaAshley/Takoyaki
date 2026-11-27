import { useMemo } from "react";
import { useProjects } from "@/state/conversation-store";
import { useIdentities } from "@/state/identities-store";
import { useMachineChanges, type MachineChange } from "@/state/machine-changes-store";

/**
 * Agents on their way back from the archive, as greyed "Coming back…" rows where each
 * will land: inside its project's section (`project` = that project's slug, `hostId` its
 * machine), or under Conversations (`project` null: no project, or one this person can't
 * see or that's gone). Once the agent is back its real row takes over; a refused
 * un-archive drops out of the machine's list and the row goes with it.
 */
export function ComingBackRows({
  project,
  hostId,
  variant,
}: {
  project: string | null;
  hostId?: string;
  variant: "mobile" | "desktop";
}) {
  const all = useMachineChanges();
  const { byHostKey } = useIdentities();
  const projects = useProjects();
  const rows = useMemo(() => {
    const out: Array<{ hostId: string; change: MachineChange }> = [];
    const seen = new Set<string>();
    for (const [h, changes] of all) {
      if (hostId !== undefined && h !== hostId) continue;
      for (const c of changes) {
        const name = c.target.name;
        if (c.state !== "returning" || c.target.type !== "agent" || name === null) continue;
        const key = `${h}::${name.toLowerCase()}`;
        // Back already (its real row shows), or listed twice.
        if (byHostKey.has(key) || seen.has(key)) continue;
        const landsIn = c.card?.project ?? null;
        const landsInSeen =
          landsIn !== null && projects.some((p) => String(p.hostId) === h && p.slug === landsIn) ? landsIn : null;
        if (landsInSeen !== project) continue;
        seen.add(key);
        out.push({ hostId: h, change: c });
      }
    }
    return out;
  }, [all, byHostKey, projects, project, hostId]);

  return (
    <>
      {rows.map(({ hostId: h, change }) => {
        const name = change.card?.displayName || change.target.name || "";
        return (
          <div className="relative" key={`coming-back:${h}:${change.target.name}`} data-machine-mark="returning">
            <div
              className={`pv-row ${variant === "mobile" ? "pv-row--mobile" : "pv-row--desktop"} pv-row--coming-back`}
              data-testid="pv-coming-back-row"
              aria-label={`${name} is coming back`}
            >
              <div className="pv-avatar">
                <span className="pv-avatar-initial">{name.trim().charAt(0).toUpperCase() || "?"}</span>
              </div>
              <div className="pv-body">
                <span className="pv-label">{name}</span>
              </div>
              <span className="pv-machine-mark pv-machine-mark--returning">Coming back…</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
