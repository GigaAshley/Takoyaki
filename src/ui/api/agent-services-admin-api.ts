/**
 * Admin → Services — frontend client.
 *
 * Backing routes: src/backend/agent-services/admin/routes.ts. Admin-only.
 * Write-only: the API says whether a key is set and when, never its value.
 */

import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";

export type ServiceState = "not_set_up" | "ready" | "failing";

export interface KeyStoreInfo {
  kind: "database" | "parameter_store";
  /** e.g. "the database", "AWS Parameter Store under /takoyaki/t1000". */
  label: string;
  /** Set when the store can't be used at all (half set up). */
  problem: string | null;
  /** ISO time AWS stopped answering; last-read keys are in use meanwhile. */
  unreachableSince: string | null;
}

export interface ServiceSummary {
  name: string;
  title: string;
  description: string;
  state: ServiceState;
  /** What's missing while not set up (labels). */
  missing: string[];
  /** Why the key store couldn't say which keys are set, when it couldn't. */
  keyProblem: string | null;
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
  /** Null when the key store can't tell right now. */
  isSet: boolean | null;
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

/**
 * A key change the key store couldn't make (AWS refused it, or couldn't be
 * reached) comes back as 424/503 with a message saying what to fix. The
 * shared handler would turn that into a generic server error, so it's kept.
 */
function keyStoreError(error: unknown, operation: string): never {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const message = (error.response?.data as { error?: unknown } | undefined)?.error;
    if ((status === 424 || status === 503) && typeof message === "string" && message) throw new Error(message);
  }
  handleApiError(error, operation);
}

export async function setServiceKey(service: string, key: string, value: string): Promise<void> {
  try {
    await authApi.put(`${BASE}/${enc(service)}/keys/${enc(key)}`, { value });
  } catch (error) {
    keyStoreError(error, "save key");
  }
}

export async function removeServiceKey(service: string, key: string): Promise<void> {
  try {
    await authApi.delete(`${BASE}/${enc(service)}/keys/${enc(key)}`);
  } catch (error) {
    keyStoreError(error, "remove key");
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
