/**
 * agent-services/admin/orphaned-grants.ts — the start-up check for
 * switches left on for machines that no longer exist (a host deleted or
 * re-addressed). They do nothing, but would come back to life if that id is
 * ever used again, so say so.
 */

import { systemLogger } from "../../utils/logger.js";
import { allGrants } from "./grants.js";
import { listAgentMachines } from "./machines.js";

/** Never throws. */
export async function warnOrphanedGrants(): Promise<void> {
  try {
    const known = new Set((await listAgentMachines()).map((m) => m.machineId));
    const orphaned = (await allGrants()).filter((g) => !known.has(g.machineId));
    if (orphaned.length > 0) {
      systemLogger.warn("agent-services: services switched on for machines that no longer exist", {
        operation: "agent_services_orphaned_grants",
        orphaned,
      });
    }
  } catch (err) {
    systemLogger.warn("agent-services: couldn't check for switches on removed machines", {
      operation: "agent_services_orphaned_grants_check_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
