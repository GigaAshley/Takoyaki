/**
 * agent-services/admin/machines.ts — the machines services can be switched
 * on for: host rows set to run agents, one entry per machine (rows of the
 * same box share a machine id).
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { hosts } from "../../database/db/schema.js";
import type { AgentMachine } from "./overview.js";

/** Agent machines: host rows set to run agents, one entry per machine. */
export async function listAgentMachines(): Promise<AgentMachine[]> {
  const rows = await getDb()
    .select({ id: hosts.id, name: hosts.name, machineId: hosts.machineId })
    .from(hosts)
    .where(eq(hosts.runsFleetSubstrate, true));
  const byMachine = new Map<string, AgentMachine>();
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    const machineId = String(r.machineId ?? r.id);
    const m = byMachine.get(machineId) ?? { machineId, name: r.name || `host ${r.id}`, hostIds: [] };
    m.hostIds.push(String(r.id));
    byMachine.set(machineId, m);
  }
  return [...byMachine.values()].sort((a, b) => a.name.localeCompare(b.name));
}
