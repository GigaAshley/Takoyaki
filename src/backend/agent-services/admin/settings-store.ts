/**
 * agent-services/admin/settings-store.ts — services' settings (e.g. which
 * provider speech to text uses). Plain values: a setting is a choice, not a
 * secret.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { agentServiceSettings } from "../../database/db/schema.js";
import type { ServiceSettingSpec } from "../engine/types.js";
import { persist } from "./persist.js";

/** What is stored for a service, without defaults. */
export async function storedSettings(service: string): Promise<Record<string, string>> {
  const rows = await getDb()
    .select({ name: agentServiceSettings.name, value: agentServiceSettings.value })
    .from(agentServiceSettings)
    .where(eq(agentServiceSettings.service, service));
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/**
 * Every declared setting's value: stored, else its default, else "". A
 * stored value that is no longer one of the options counts as unset.
 */
export async function effectiveSettings(
  service: string,
  specs: Record<string, ServiceSettingSpec> | undefined,
): Promise<Record<string, string>> {
  const stored = await storedSettings(service);
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs ?? {})) {
    const value = stored[name];
    const valid = value !== undefined && spec.options.some((o) => o.value === value);
    out[name] = valid ? value : (spec.default ?? "");
  }
  return out;
}

export async function setSetting(
  service: string,
  name: string,
  value: string,
  updatedBy: string | null,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await getDb()
    .insert(agentServiceSettings)
    .values({ service, name, value, updatedAt, updatedBy })
    .onConflictDoUpdate({
      target: [agentServiceSettings.service, agentServiceSettings.name],
      set: { value, updatedAt, updatedBy },
    });
  await persist("agent_service_setting_set");
}

export async function clearSetting(service: string, name: string): Promise<void> {
  const deleted = await getDb()
    .delete(agentServiceSettings)
    .where(and(eq(agentServiceSettings.service, service), eq(agentServiceSettings.name, name)))
    .returning({ name: agentServiceSettings.name });
  if (deleted.length > 0) await persist("agent_service_setting_clear");
}
