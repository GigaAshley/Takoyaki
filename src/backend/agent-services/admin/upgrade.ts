/**
 * agent-services/admin/upgrade.ts — the one-time move of service keys out
 * of the server settings (environment), and the start-up note about any
 * left behind.
 *
 * Runs at every start, before the engine. The import runs once per instance
 * (a marker in the settings table), and only fills keys and settings that
 * aren't stored yet, so it never overwrites what an admin set:
 *   - every key a service declares is copied from the environment variable
 *     of the same name, when the service needs it with its settings. For
 *     the phone keys that is a move (nothing else reads them); image
 *     generation's OpenAI key is a copy (voice and avatars keep reading the
 *     environment's);
 *   - speech to text copies voice's setup: STT_PROVIDER (unset means Amazon
 *     on an instance that already has agent machines; a brand-new instance
 *     is left not set up), STT_FALLBACK_PROVIDER and STT_LANGUAGE.
 * Machine switches are not touched: every service starts off everywhere.
 *
 * After the import, service keys are never read from the environment. At
 * each start, keys still sitting there that only a service uses are named
 * in one log line, so the operator can delete them.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../database/db/index.js";
import { hosts, settings as settingsTable } from "../../database/db/schema.js";
import { systemLogger } from "../../utils/logger.js";
import type { ServiceDefinition } from "../engine/types.js";
import { getKeyStore } from "./key-store.js";
import { effectiveSettings, setSetting, storedSettings } from "./settings-store.js";
import { persist } from "./persist.js";
import { allGrants } from "./grants.js";
import { listAgentMachines } from "./machines.js";

export const UPGRADE_MARKER = "agent_services_env_import";

let markFinished: () => void = () => {};
/**
 * Resolves once runServicesUpgrade has finished (imported or not). Admin
 * changes wait on it, so the import never overwrites or brings back a key an
 * admin changed while the server was still starting.
 */
export const servicesUpgradeFinished: Promise<void> = new Promise((r) => (markFinished = r));

/**
 * Environment variables the app itself reads (voice, avatars), so their
 * presence is expected even when a service declares a key of that name.
 */
const READ_BY_THE_APP = new Set([
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
]);

type Env = Record<string, string | undefined>;

async function markerSet(): Promise<boolean> {
  const rows = await getDb()
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, UPGRADE_MARKER))
    .limit(1);
  return rows.length > 0;
}

async function hasAgentMachines(): Promise<boolean> {
  const rows = await getDb()
    .select({ id: hosts.id })
    .from(hosts)
    .where(eq(hosts.runsFleetSubstrate, true))
    .limit(1);
  return rows.length > 0;
}

/** Speech to text's settings from voice's, where none are stored yet. */
async function importSttSettings(def: ServiceDefinition, env: Env, existing: boolean): Promise<string[]> {
  const specs = def.settings ?? {};
  const stored = await storedSettings(def.name);
  const valid = (name: string, v: string | undefined) =>
    v !== undefined && v !== "" && (specs[name]?.options ?? []).some((o) => o.value === v);
  const imported: string[] = [];
  const put = async (name: string, value: string) => {
    if (stored[name] !== undefined) return;
    await setSetting(def.name, name, value, null);
    imported.push(name);
  };

  const rawProvider = (env.STT_PROVIDER ?? "").trim().toLowerCase();
  const provider = rawProvider === "" ? (existing ? "bedrock" : "") : rawProvider;
  if (valid("provider", provider)) await put("provider", provider);
  const backup = (env.STT_FALLBACK_PROVIDER ?? "").trim().toLowerCase();
  if (valid("backup", backup) && backup !== provider) await put("backup", backup);
  // A region-style code (en-US) pins its language (en).
  const language = (env.STT_LANGUAGE ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (valid("language", language)) await put("language", language);
  return imported;
}

/** The one-time import. True when it ran this start. */
export async function importFromEnvironment(
  services: readonly ServiceDefinition[],
  env: Env = process.env,
): Promise<boolean> {
  if (await markerSet()) return false;
  const store = getKeyStore();
  const existing = await hasAgentMachines();
  const summary: Record<string, { keys: string[]; settings: string[] }> = {};

  for (const def of services) {
    const settings = def.name === "stt" ? await importSttSettings(def, env, existing) : [];
    const current = await effectiveSettings(def.name, def.settings);
    const keys: string[] = [];
    const have = new Set((await store.status(def.name)).map((k) => k.name));
    for (const [name, spec] of Object.entries(def.secrets ?? {})) {
      const value = env[name]?.trim();
      if (!value || have.has(name)) continue;
      if (!(spec.neededWhen?.(current) ?? true)) continue;
      await store.set(def.name, name, value, null);
      keys.push(name);
    }
    if (keys.length > 0 || settings.length > 0) summary[def.name] = { keys, settings };
  }

  await getDb()
    .insert(settingsTable)
    .values({ key: UPGRADE_MARKER, value: new Date().toISOString() })
    .onConflictDoNothing();
  await persist("agent_services_env_import");
  systemLogger.info("agent-services: service keys and settings brought in from the server settings (once)", {
    operation: "agent_services_env_import",
    imported: summary,
  });
  return true;
}

/** Service keys still in the environment that nothing but a service uses. */
export function leftoverServiceKeys(services: readonly ServiceDefinition[], env: Env = process.env): string[] {
  const names = new Set<string>();
  for (const def of services) {
    for (const name of Object.keys(def.secrets ?? {})) {
      if (env[name]?.trim() && !READ_BY_THE_APP.has(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/** Never throws: a failed import leaves services not set up, not the server down. */
export async function runServicesUpgrade(
  services: readonly ServiceDefinition[],
  env: Env = process.env,
): Promise<void> {
  try {
    await importFromEnvironment(services, env);
  } catch (err) {
    systemLogger.error("agent-services: importing keys from the server settings failed; will retry next start", {
      operation: "agent_services_env_import_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  markFinished();
  const leftover = leftoverServiceKeys(services, env);
  if (leftover.length > 0) {
    systemLogger.info(
      `agent-services: ignoring service keys still in the server settings (${leftover.join(", ")}); they live in Admin → Services now and can be deleted from the settings file`,
      { operation: "agent_services_env_keys_ignored", names: leftover },
    );
  }
  await warnOrphanedGrants();
}

/**
 * Switches for a machine id no agent machine has any more (a host deleted
 * or re-addressed). They do nothing, but would come back to life if that id
 * is ever used again, so say so at start.
 */
async function warnOrphanedGrants(): Promise<void> {
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
