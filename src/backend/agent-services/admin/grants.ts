/**
 * agent-services/admin/grants.ts — which machines may use which service.
 *
 * A machine is a hosts.machine_id: every host row for the same box shares
 * it. A service is on for a machine only when a grant row exists, so a new
 * service and a new machine both start off everywhere.
 *
 * Grants are read on every request and every sweep, so they are cached in
 * memory and the cache is replaced on each change.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { agentServiceGrants } from "../../database/db/schema.js";
import { persist } from "./persist.js";

let cache: Map<string, Set<string>> | null = null;
/** Bumped on every change: a load that began before one never fills the cache. */
let generation = 0;

async function load(): Promise<Map<string, Set<string>>> {
  if (cache) return cache;
  const started = generation;
  const rows = await getDb()
    .select({ service: agentServiceGrants.service, machineId: agentServiceGrants.machineId })
    .from(agentServiceGrants);
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.service)) map.set(r.service, new Set());
    map.get(r.service)!.add(r.machineId);
  }
  if (started === generation) cache = map;
  return map;
}

export async function isEnabled(service: string, machineId: string): Promise<boolean> {
  return (await load()).get(service)?.has(machineId) ?? false;
}

/** The machines a service is on for. */
export async function enabledMachines(service: string): Promise<Set<string>> {
  return new Set((await load()).get(service) ?? []);
}

/** The services switched on for a machine. */
export async function enabledServices(machineId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [service, machines] of await load()) {
    if (machines.has(machineId)) out.add(service);
  }
  return out;
}

/** True if anything changed. */
export async function setEnabled(
  service: string,
  machineId: string,
  enabled: boolean,
  updatedBy: string | null,
): Promise<boolean> {
  if ((await isEnabled(service, machineId)) === enabled) return false;
  const db = getDb();
  if (enabled) {
    await db
      .insert(agentServiceGrants)
      .values({ service, machineId, updatedAt: new Date().toISOString(), updatedBy })
      .onConflictDoNothing();
  } else {
    await db
      .delete(agentServiceGrants)
      .where(and(eq(agentServiceGrants.service, service), eq(agentServiceGrants.machineId, machineId)));
  }
  cache = null;
  generation++;
  await persist("agent_service_grant_set");
  return true;
}

/** Test hook: forget the cache. */
export function __resetGrantCache(): void {
  cache = null;
  generation++;
}

/** Every switched-on (service, machine) pair, for the start-up orphan check. */
export async function allGrants(): Promise<Array<{ service: string; machineId: string }>> {
  return getDb()
    .select({ service: agentServiceGrants.service, machineId: agentServiceGrants.machineId })
    .from(agentServiceGrants);
}
