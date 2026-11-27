/**
 * agent-services/http/production.ts — the /agent-services router as the app
 * mounts it (database.ts), wired to the real credential store and host
 * table. boot.ts hands it the running engine and job store.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { hosts } from "../../database/db/schema.js";
import type { RequestHost } from "../engine/engine.js";
import { identifyMachine } from "../machine-credentials/store.js";
import { createAgentServicesRouter, type ServiceRuntime } from "./routes.js";

let runtime: ServiceRuntime | null = null;

export function setServiceRuntime(rt: ServiceRuntime | null): void {
  runtime = rt;
}

/**
 * The host row a machine's requests run as: its lowest-numbered row set to
 * run agents. A machine is named by hosts.machine_id, or by the row id for a
 * row without one (admin/machines.ts).
 */
export async function hostForMachine(machineId: string): Promise<RequestHost | null> {
  const rows = await getDb()
    .select({ id: hosts.id, machineId: hosts.machineId })
    .from(hosts)
    .where(eq(hosts.runsFleetSubstrate, true))
    .orderBy(asc(hosts.id));
  const row = rows.find((r) => String(r.machineId ?? r.id) === machineId);
  if (!row) return null;
  return { id: String(row.id), idNum: row.id, machineId };
}

export const agentServicesRouter = createAgentServicesRouter({
  runtime: () => runtime,
  identifyMachine: (token) => identifyMachine(token),
  hostForMachine,
});
