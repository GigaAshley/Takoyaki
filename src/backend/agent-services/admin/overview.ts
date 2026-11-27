/**
 * agent-services/admin/overview.ts — what Admin → Services shows, built
 * from the service definitions and the stores. Never carries a key value.
 *
 * State, in order:
 *   not_set_up  a required setting has no value, a key the service needs
 *               with its settings isn't set, or a service it uses isn't set
 *               up;
 *   failing     the key store can't say whether a needed key is set (AWS
 *               unreachable, or refusing), or the last success-or-fault
 *               record was a fault (usage.ts);
 *   ready.
 */

import type { ServiceDefinition } from "../engine/types.js";
import type { InstanceKeyStore } from "./key-store.js";
import type { ServiceHealth, UsageSummary } from "./usage.js";
import type { MachineCredentialStatus } from "../machine-credentials/store.js";

export type ServiceState = "not_set_up" | "ready" | "failing";

export interface AgentMachine {
  machineId: string;
  name: string;
  /** Every host row for the machine set to run agents. */
  hostIds: string[];
}

export interface OverviewDeps {
  /** Every service, to judge the ones a service uses. */
  services(): readonly ServiceDefinition[];
  keyStore: InstanceKeyStore;
  effectiveSettings(service: string, specs: ServiceDefinition["settings"]): Promise<Record<string, string>>;
  storedSettings(service: string): Promise<Record<string, string>>;
  enabledMachines(service: string): Promise<Set<string>>;
  listAgentMachines(): Promise<AgentMachine[]>;
  serviceHealth(service: string): Promise<ServiceHealth>;
  usageSummary(service: string): Promise<UsageSummary>;
  /** Each machine's service credential, without values. */
  listMachineCredentialStatus(): Promise<MachineCredentialStatus[]>;
  listUsers(): Promise<Array<{ id: string; username: string }>>;
  listPersonKeyStatus(service: string): Promise<Array<{ userId: string; name: string; updatedAt: string }>>;
}

export interface KeyView {
  name: string;
  label: string;
  description: string;
  /** Needed with the current settings (else optional, e.g. another provider's). */
  needed: boolean;
  /** Null when the key store can't tell right now. */
  isSet: boolean | null;
  updatedAt: string | null;
}

export interface SettingView {
  name: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  required: boolean;
  /** Current value, default applied; "" when unset. */
  value: string;
}

export interface ServiceSummary {
  name: string;
  title: string;
  description: string;
  state: ServiceState;
  /** Missing pieces, when not set up: key labels and setting labels. */
  missing: string[];
  /** Why the key store couldn't say which keys are set, when it couldn't. */
  keyProblem: string | null;
  lastUsedAt: string | null;
  machinesOn: number;
  machinesTotal: number;
}

export interface MachineView {
  machineId: string;
  name: string;
  enabled: boolean;
}

/** One machine's credential for calling services, as Admin → Services lists it. */
export interface MachineCredentialView {
  machineId: string;
  name: string;
  /** "pending" until the backend first issues one (within a minute of the machine appearing). */
  state: "active" | "revoked" | "pending";
  /** When the current credential was issued (replaced daily). */
  issuedAt: string | null;
  revokedAt: string | null;
  /** Username of the admin who revoked it, when known. */
  revokedBy: string | null;
}

export interface ServiceDetail extends ServiceSummary {
  keys: KeyView[];
  settings: SettingView[];
  machines: MachineView[];
  usage: UsageSummary & {
    byMachine: Array<UsageSummary["byMachine"][number] & { name: string }>;
    recentErrors: Array<UsageSummary["recentErrors"][number] & { name: string }>;
  };
  lastFault: ServiceHealth["lastFault"];
  /** Null when the service has no per-person keys. */
  personKeys: null | {
    keys: Array<{ name: string; label: string; description: string | null; hasFallback: boolean }>;
    people: Array<{ userId: string; username: string; set: Record<string, string | null> }>;
  };
}

async function keysAndSettings(def: ServiceDefinition, deps: OverviewDeps) {
  const settings = await deps.effectiveSettings(def.name, def.settings);
  const names = Object.keys(def.secrets ?? {});
  let status: Awaited<ReturnType<InstanceKeyStore["status"]>> = [];
  let keyProblem: string | null = null;
  if (names.length > 0) {
    try {
      status = await deps.keyStore.status(def.name, names);
    } catch (err) {
      keyProblem = err instanceof Error ? err.message : String(err);
    }
  }
  const keys: KeyView[] = Object.entries(def.secrets ?? {}).map(([name, spec]) => {
    const s = status.find((k) => k.name === name);
    return {
      name,
      label: spec.label,
      description: spec.description,
      needed: spec.neededWhen?.(settings) ?? true,
      isSet: s ? s.isSet : null,
      updatedAt: s?.updatedAt ?? null,
    };
  });
  const unknown = keys.filter((k) => k.needed && k.isSet === null);
  if (!keyProblem && unknown.length > 0) {
    const info = deps.keyStore.info();
    keyProblem =
      info.problem ??
      (info.unreachableSince
        ? `Can't reach ${info.label} to check ${unknown.map((k) => k.label).join(", ")}`
        : `Can't check ${unknown.map((k) => k.label).join(", ")} in ${info.label}`);
  }
  const settingViews: SettingView[] = Object.entries(def.settings ?? {}).map(([name, spec]) => ({
    name,
    label: spec.label,
    description: spec.description,
    options: spec.options.map((o) => ({ value: o.value, label: o.label })),
    required: spec.required ?? false,
    value: settings[name] ?? "",
  }));
  const missing = [
    ...settingViews.filter((s) => s.required && !s.value).map((s) => s.label),
    ...keys.filter((k) => k.needed && k.isSet === false).map((k) => k.label),
  ];
  return { keys, settings: settingViews, missing, keyProblem };
}

export async function summarize(
  def: ServiceDefinition,
  deps: OverviewDeps,
  machines: AgentMachine[],
): Promise<ServiceSummary & { keys: KeyView[]; settings: SettingView[]; lastFault: ServiceHealth["lastFault"] }> {
  const { keys, settings, missing, keyProblem } = await keysAndSettings(def, deps);
  for (const name of def.uses ?? []) {
    const used = deps.services().find((s) => s.name === name);
    if (used && (await keysAndSettings(used, deps)).missing.length > 0) missing.push(used.title);
  }
  const health = await deps.serviceHealth(def.name);
  const on = await deps.enabledMachines(def.name);
  const state: ServiceState =
    missing.length > 0 ? "not_set_up" : keyProblem || health.failing ? "failing" : "ready";
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    state,
    missing,
    keyProblem,
    lastUsedAt: health.lastUsedAt,
    machinesOn: machines.filter((m) => on.has(m.machineId)).length,
    machinesTotal: machines.length,
    keys,
    settings,
    lastFault: health.lastFault,
  };
}

export async function listServices(services: readonly ServiceDefinition[], deps: OverviewDeps): Promise<ServiceSummary[]> {
  const machines = await deps.listAgentMachines();
  const out: ServiceSummary[] = [];
  for (const def of services) {
    const s = await summarize(def, deps, machines);
    out.push({
      name: s.name,
      title: s.title,
      description: s.description,
      state: s.state,
      missing: s.missing,
      keyProblem: s.keyProblem,
      lastUsedAt: s.lastUsedAt,
      machinesOn: s.machinesOn,
      machinesTotal: s.machinesTotal,
    });
  }
  return out;
}

export async function serviceDetail(def: ServiceDefinition, deps: OverviewDeps): Promise<ServiceDetail> {
  const machines = await deps.listAgentMachines();
  const summary = await summarize(def, deps, machines);
  const on = await deps.enabledMachines(def.name);
  const nameOf = new Map(machines.map((m) => [m.machineId, m.name]));
  // A machine removed since its requests were recorded.
  const machineName = (id: string) => nameOf.get(id) ?? "a removed machine";

  const machineViews: MachineView[] = machines.map((m) => ({
    machineId: m.machineId,
    name: m.name,
    enabled: on.has(m.machineId),
  }));

  const usage = await deps.usageSummary(def.name);
  const personSpecs = Object.entries(def.userSecrets ?? {});
  let personKeys: ServiceDetail["personKeys"] = null;
  if (personSpecs.length > 0) {
    const status = await deps.listPersonKeyStatus(def.name);
    const users = await deps.listUsers();
    personKeys = {
      keys: personSpecs.map(([name, spec]) => ({
        name,
        label: spec.label,
        description: spec.description ?? null,
        hasFallback: Boolean(spec.fallbackKey && summary.keys.find((k) => k.name === spec.fallbackKey)?.isSet),
      })),
      people: users
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((u) => ({
          userId: u.id,
          username: u.username,
          set: Object.fromEntries(
            personSpecs.map(([name]) => [
              name,
              status.find((s) => s.userId === u.id && s.name === name)?.updatedAt ?? null,
            ]),
          ),
        })),
    };
  }

  return {
    ...summary,
    machines: machineViews,
    usage: {
      ...usage,
      byMachine: usage.byMachine.map((m) => ({ ...m, name: machineName(m.machineId) })),
      recentErrors: usage.recentErrors.map((e) => ({ ...e, name: machineName(e.machineId) })),
    },
    personKeys,
  };
}

/** Every agent machine's service credential, by machine name. */
export async function machineCredentials(deps: OverviewDeps): Promise<MachineCredentialView[]> {
  const machines = await deps.listAgentMachines();
  const status = new Map((await deps.listMachineCredentialStatus()).map((c) => [c.machineId, c]));
  const usernames = new Map((await deps.listUsers()).map((u) => [u.id, u.username]));
  return machines.map((m) => {
    const c = status.get(m.machineId);
    return {
      machineId: m.machineId,
      name: m.name,
      state: c ? c.state : "pending",
      issuedAt: c?.issuedAt ?? null,
      revokedAt: c?.revokedAt ?? null,
      revokedBy: c?.revokedBy ? (usernames.get(c.revokedBy) ?? null) : null,
    };
  });
}
