/**
 * Admin → Services — frontend client.
 *
 * Backing routes: src/backend/agent-services/admin/routes.ts. Admin-only.
 * Write-only: the API says whether a key is set and when, never its value.
 */

import { authApi, handleApiError } from "@/main-axios";

export type ServiceState = "not_set_up" | "ready" | "failing";

export interface KeyStoreInfo {
  /** e.g. "the database". */
  kind: string;
  writable: boolean;
}

export interface ServiceSummary {
  name: string;
  title: string;
  description: string;
  state: ServiceState;
  /** What's missing while not set up (labels). */
  missing: string[];
  lastUsedAt: string | null;
  machinesOn: number;
  machinesTotal: number;
}

export interface ServiceKey {
  name: string;
  label: string;
  description: string;
  /** Needed with the current settings. */
  needed: boolean;
  isSet: boolean;
  updatedAt: string | null;
}

export interface ServiceSetting {
  name: string;
  label: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  required: boolean;
  value: string;
}

export interface ServiceMachine {
  machineId: string;
  name: string;
  enabled: boolean;
  unreachableSince: string | null;
}

export interface ServiceDetail extends ServiceSummary {
  keys: ServiceKey[];
  settings: ServiceSetting[];
  machines: ServiceMachine[];
  lastFault: { at: string; code: string | null } | null;
  usage: {
    sinceAt: string;
    requests: number;
    failed: number;
    byMachine: Array<{ machineId: string; name: string; requests: number; failed: number; lastAt: string }>;
    recentErrors: Array<{ at: string; machineId: string; name: string; code: string | null; fault: boolean }>;
  };
  personKeys: null | {
    keys: Array<{ name: string; label: string; description: string | null; hasFallback: boolean }>;
    people: Array<{ userId: string; username: string; set: Record<string, string | null> }>;
  };
}

const BASE = "/users/admin/services";
const enc = encodeURIComponent;

export async function listAgentServices(): Promise<{ keyStore: KeyStoreInfo; services: ServiceSummary[] }> {
  try {
    return (await authApi.get(BASE)).data;
  } catch (error) {
    handleApiError(error, "list services");
  }
}

export async function getAgentService(name: string): Promise<{ keyStore: KeyStoreInfo; service: ServiceDetail }> {
  try {
    return (await authApi.get(`${BASE}/${enc(name)}`)).data;
  } catch (error) {
    handleApiError(error, "load service");
  }
}

export async function setServiceKey(service: string, key: string, value: string): Promise<void> {
  try {
    await authApi.put(`${BASE}/${enc(service)}/keys/${enc(key)}`, { value });
  } catch (error) {
    handleApiError(error, "save key");
  }
}

export async function removeServiceKey(service: string, key: string): Promise<void> {
  try {
    await authApi.delete(`${BASE}/${enc(service)}/keys/${enc(key)}`);
  } catch (error) {
    handleApiError(error, "remove key");
  }
}

/** "" puts the setting back to its default (or unset). */
export async function setServiceSetting(service: string, setting: string, value: string): Promise<void> {
  try {
    await authApi.put(`${BASE}/${enc(service)}/settings/${enc(setting)}`, { value });
  } catch (error) {
    handleApiError(error, "save setting");
  }
}

export async function setServiceMachine(service: string, machineId: string, enabled: boolean): Promise<void> {
  try {
    await authApi.put(`${BASE}/${enc(service)}/machines/${enc(machineId)}`, { enabled });
  } catch (error) {
    handleApiError(error, "switch machine");
  }
}

export async function setPersonKey(service: string, userId: string, key: string, value: string): Promise<void> {
  try {
    await authApi.put(`${BASE}/${enc(service)}/people/${enc(userId)}/keys/${enc(key)}`, { value });
  } catch (error) {
    handleApiError(error, "save person's key");
  }
}

export async function removePersonKey(service: string, userId: string, key: string): Promise<void> {
  try {
    await authApi.delete(`${BASE}/${enc(service)}/people/${enc(userId)}/keys/${enc(key)}`);
  } catch (error) {
    handleApiError(error, "remove person's key");
  }
}
