/**
 * agent-services/admin/persist.ts — flush an agent-services write to disk.
 * The database lives in memory; writes reach disk only through a save.
 */

import { DatabaseSaveTrigger } from "../../utils/database-save-trigger.js";
import { databaseLogger } from "../../utils/logger.js";

/** Keys, settings and switches: flush now. Usage records: debounced. */
export async function persist(reason: string, urgent = true): Promise<void> {
  try {
    if (urgent) await DatabaseSaveTrigger.forceSave(reason);
    else await DatabaseSaveTrigger.triggerSave(reason);
  } catch (err) {
    // Non-fatal: the write is in RAM and lands on disk with the next save.
    databaseLogger.warn("agent-services save failed (non-fatal)", {
      operation: "agent_services_save_failed",
      reason,
      error: err,
    });
  }
}
