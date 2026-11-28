import { useEffect, useRef } from "react";
import { markNoticeSeen } from "@/api/machine-changes-api";
import { useAppTiles } from "@/state/app-tiles-store";
import { useProjects } from "@/state/conversation-store";
import { useIdentities } from "@/state/identities-store";
import { useMachineChanges, isNotice, type MachineChange } from "@/state/machine-changes-store";
import { showNoticePopup, showStuckPopup } from "./machine-change-words";

/**
 * The machine notices with no row to mark, as one-time pop-ups — on whichever of this
 * person's devices claims each first (the server answers the first claim only):
 *
 *   - a refusal or failure whose thing has no row: a project that was never made, an
 *     agent, app or role that didn't come back from the archive, a role archive;
 *   - an archive whose clean-up has been stuck 10 minutes or more (one pop-up for all it
 *     took);
 *   - an agent of theirs archived with a project by someone else.
 *
 * Notices about something with a row are that row's failure mark instead
 * (MachineChangeMark). Mounted once, in AppShell; renders nothing.
 */
export function MachineNoticePopups(): null {
  const all = useMachineChanges();
  const { byHostKey, loaded: identitiesLoaded } = useIdentities();
  const projects = useProjects();
  const apps = useAppTiles();
  // Claimed (or being claimed) in this tab: never asked twice.
  const handled = useRef(new Set<string>());

  useEffect(() => {
    // Until the agent list is in, every agent would look row-less.
    if (!identitiesLoaded) return;
    const hasRow = (hostId: string, c: MachineChange): boolean => {
      const name = c.target.name;
      if (name === null) return false;
      switch (c.target.type) {
        case "agent":
          return byHostKey.has(`${hostId}::${name.toLowerCase()}`);
        case "project":
          return projects.some((p) => String(p.hostId) === hostId && p.slug === name);
        case "app":
          return apps.some((a) => a.hostId === hostId && a.slug === name);
        default:
          return false;
      }
    };
    for (const [hostId, changes] of all) {
      // A role archive lists the role and the agents it takes under the same request: one
      // pop-up for the request, about the role.
      const notices = new Map<string, MachineChange>();
      for (const c of changes) {
        // Theirs to be told: their own change, or their agent archived by someone else.
        // A taken agent is archived: any row this device still has for it is on its way out.
        if (!isNotice(c) || !(c.mine || c.state === "taken")) continue;
        if (c.state !== "taken" && hasRow(hostId, c)) continue;
        const prev = notices.get(c.id);
        if (!prev || c.target.type === "role") notices.set(c.id, c);
      }
      // A request with a row for any of its things is shown on that row.
      for (const c of changes) {
        if (isNotice(c) && c.state !== "taken" && notices.has(c.id) && hasRow(hostId, c)) notices.delete(c.id);
      }
      for (const [id, c] of notices) {
        claimThen(hostId, id, () => showNoticePopup(c, thingName(c)));
      }
      const stuck = new Map<string, MachineChange[]>();
      for (const c of changes) {
        if (c.state !== "stuck") continue;
        stuck.set(c.id, [...(stuck.get(c.id) ?? []), c]);
      }
      for (const [id, group] of stuck) {
        claimThen(hostId, `${id}:stuck`, () => showStuckPopup(group, group.map(thingName)));
      }
    }

    function claimThen(hostId: string, key: string, show: () => Promise<void>): void {
      const k = `${hostId}:${key}`;
      if (handled.current.has(k)) return;
      handled.current.add(k);
      markNoticeSeen(hostId, key)
        .then((first) => {
          console.info({ operation: "machine_notice_popup_claim", hostId, key, first });
          if (first) void show();
        })
        .catch((err: unknown) => {
          // Not claimed: try again when the list next changes.
          handled.current.delete(k);
          console.warn({
            operation: "machine_notice_popup_claim_failed",
            hostId,
            key,
            errMessage: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }, [all, byHostKey, identitiesLoaded, projects, apps]);

  return null;
}

function thingName(c: MachineChange): string {
  if (c.target.type === "project" && c.target.name === null) return `the project "${c.target.displayName ?? ""}"`;
  if (c.card?.displayName) return c.card.displayName;
  const name = c.target.displayName ?? c.target.name ?? "it";
  return c.target.type === "role" ? `the role ${name}` : name;
}
