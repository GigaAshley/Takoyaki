// Role actions that run behind a confirm, shared by the detail views and a
// swipe on the row in their lists: archive a role ("Archive role…") and
// delete a role skill ("Delete skill…").

import { toast } from "sonner";
import { kitAlert, kitConfirm } from "@/components/kit";
import { archiveRole, getRoleArchivePreflight, type RoleArchiveContents } from "@/api/role-archive-api";
import { MachineChangeError, reasonSentence } from "@/api/machine-changes-api";
import { deleteRoleSkill } from "@/api/role-skills-api";
import { checkActiveWakeupsForAgents, multiAgentWakeupWarning, type WakeupCheck } from "@/shell/archive-wakeup-check";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Resolves true once the role is archived; false when cancelled or failed
 *  (a failure has already been shown). The confirm lists the agents the
 *  role's machine says hold it right now, and the archive takes exactly
 *  those: if that changes before it runs, nothing is archived and the confirm
 *  comes back with the new list. */
export async function confirmAndArchiveRole(args: { hostId: number; name: string; label: string }): Promise<boolean> {
  const { hostId, name, label } = args;
  type Agent = RoleArchiveContents["agents"][number];
  const agentLabel = (i: Agent) => i.task || i.displayName || i.name;
  const body = (agents: Agent[], wakeupWarning: string) =>
    agents.length === 0
      ? "No agents hold it. This can't be undone from here — archived roles can be brought back from Archived roles."
      : `This also archives the ${plural(agents.length, "agent")} holding it:\n` +
        agents.map((i) => `• ${agentLabel(i)}`).join("\n") +
        (wakeupWarning ? `\n\n${wakeupWarning}` : "");
  // A role lives on one host, and so do the agents holding it. The confirm
  // opens at once; Archive waits for the machine's list and the agents'
  // wake-up checks, which add the agents whose wake-ups would stop.
  const confirmWith = async (
    agentsNow: Promise<Agent[]>,
    title: string,
  ): Promise<{ ok: boolean; agents: Agent[]; wakeupChecks: { check: WakeupCheck }[] }> => {
    let agents: Agent[] | null = null;
    let wakeupChecks: { check: WakeupCheck }[] = [];
    const ready = agentsNow.then(async (list) => {
      agents = list;
      if (list.length === 0) return { body: body(list, "") };
      const results = await checkActiveWakeupsForAgents(
        list.map((i) => ({ hostId, identityKey: i.name, label: agentLabel(i) })),
      );
      wakeupChecks = results;
      return { body: body(list, multiAgentWakeupWarning(results.map(({ agent, check }) => ({ label: agent.label, check })))) };
    });
    const ok = await kitConfirm({ title, body: "Checking who holds it…", ready, confirmLabel: "Archive", destructive: true });
    return { ok: ok && agents !== null, agents: agents ?? [], wakeupChecks };
  };

  let agentsNow: Promise<Agent[]> = getRoleArchivePreflight(hostId, name).then((c) => c.agents);
  let title = `Archive ${label}?`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let choice: Awaited<ReturnType<typeof confirmWith>>;
    try {
      choice = await confirmWith(agentsNow, title);
    } catch (err) {
      void kitAlert({ title: `Couldn't archive ${label}`, body: reasonOf(err) });
      return false;
    }
    if (!choice.ok) return false;
    try {
      await archiveRole(hostId, name, choice.agents.map((a) => a.name), () => {
        toast(`Still archiving ${label}`, { description: "The machine is still working on it." });
      });
      console.info({
        operation: "role_archived",
        hostId,
        roleName: name,
        agentCount: choice.agents.length,
        agentsWithWakeups: choice.wakeupChecks.filter((r) => r.check.status === "checked" && r.check.active.length > 0).length,
        agentsUnchecked: choice.wakeupChecks.filter((r) => r.check.status === "unknown").length,
      });
      return true;
    } catch (err) {
      if (err instanceof MachineChangeError && err.code === "contents_changed" && attempt < 2) {
        // Who holds it changed since the confirm: nothing was archived; show the new list.
        const current = (err.result as RoleArchiveContents | null)?.agents;
        agentsNow = Array.isArray(current) ? Promise.resolve(current) : getRoleArchivePreflight(hostId, name).then((c) => c.agents);
        title = `Who holds ${label} changed — archive it?`;
        continue;
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      console.warn({ operation: "role_archive_failed", hostId, roleName: name, errMessage, code: err instanceof MachineChangeError ? err.code : null });
      void kitAlert({ title: `Couldn't archive ${label}`, body: reasonOf(err) });
      return false;
    }
  }
  return false;
}

function reasonOf(err: unknown): string {
  if (err instanceof MachineChangeError) return reasonSentence(err.message) + (err.code === "contents_changed" ? "" : " Nothing was archived.");
  return err instanceof Error ? err.message : String(err);
}

/** Resolves true once the skill is deleted; false when cancelled or failed
 *  (a failure has already been shown). */
export async function confirmAndDeleteRoleSkill(args: {
  hostId: number;
  roleName: string;
  skill: string;
}): Promise<boolean> {
  const { hostId, roleName, skill } = args;
  if (
    !(await kitConfirm({
      title: `Delete skill "${skill}"?`,
      body: "This removes the skill and every file inside it. This can't be undone.",
      confirmLabel: "Delete skill",
      destructive: true,
    }))
  )
    return false;
  try {
    await deleteRoleSkill(hostId, roleName, skill);
    console.info({ operation: "role_skill_deleted", hostId, roleName, skill });
    return true;
  } catch (err) {
    void kitAlert({ title: "Couldn't delete the skill", body: err instanceof Error ? err.message : undefined });
    return false;
  }
}
