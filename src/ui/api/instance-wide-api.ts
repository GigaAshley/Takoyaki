import { authApi, handleApiError } from "@/main-axios";

// Client for the /instance-wide router (src/backend/database/routes/instance-wide.ts).
// Instance-wide skills and roles have a master copy in the app that is kept in
// step on the machines each one goes to (every machine, or a list an admin
// picked); the machines an admin picks also write back. Editing an
// instance-wide skill's files goes through the skills-editor API with
// INSTANCE_HOST_ID.

/** hostId the skills-editor API uses for the instance-wide master copy. */
export const INSTANCE_HOST_ID = 0;

export type InstanceWideKind = "skill" | "role";

export type InstanceWideHostState = "current" | "behind" | "conflict" | "offline";

export type InstanceWideHostStatus = {
  machineId: string;
  hostName: string;
  /** Every host row that reaches this machine. */
  hostRowIds?: string[];
  state: InstanceWideHostState;
  detail?: string;
  lastContactAt?: number;
  conflicts?: string[];
};

export type InstanceWideItem = {
  kind: InstanceWideKind;
  name: string;
  description?: string;
  updatedAt: number;
  /** Hosts not current (offline hosts are never counted). */
  behind: number;
  conflicts: number;
  /** Hosts the item currently sits on. */
  hostCount: number;
  /** One per machine the item goes to (admins only; empty for everyone else). */
  hosts: InstanceWideHostStatus[];
  /** Admins only: the machines it goes to — "all" includes machines added later. */
  targets?: SharedTargets;
  /** Admins only: the machines whose edits flow back. */
  writeBack?: string[];
  /** Listed for a host: that host's machine writes this item back. */
  writeBackHere?: boolean;
  /** Skills only: `user-invocable: false` — not offered to the user. */
  userInvocable?: false;
  /** Skills only: `disable-model-invocation: true` — agents won't use it. */
  modelInvocable?: false;
};

export type InstanceWideList = { isAdmin: boolean; items: InstanceWideItem[] };

/** "all" = every machine, including ones added later. */
export type SharedTargets = "all" | string[];

/** Which machines an item goes to, and which write back. */
export type SharedLists = { targets: SharedTargets; writeBack: string[] };

/** A fleet machine, as the machine lists show it (admins only). */
export type SharedMachine = {
  machineId: string;
  hostName: string;
  /** Every host row that reaches this machine (for matching agents to it). */
  hostRowIds: string[];
  offline: boolean;
};

/**
 * With `hostId`, only the items that go to that host's machine, each saying
 * whether the machine writes it back.
 */
export async function listInstanceWide(kind: InstanceWideKind, hostId?: number): Promise<InstanceWideList> {
  try {
    const res = await authApi.get("/instance-wide/items", { params: hostId == null ? { kind } : { kind, hostId } });
    return res.data as InstanceWideList;
  } catch (error) {
    handleApiError(error, "list instance-wide items");
  }
}

export async function listSharedMachines(): Promise<SharedMachine[]> {
  try {
    const res = await authApi.get("/instance-wide/machines");
    return (res.data as { machines: SharedMachine[] }).machines;
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't list the machines"));
  }
}

/** Same-named folders on the machines a change would add. */
export async function previewMachines(
  kind: InstanceWideKind,
  name: string,
  targets: SharedTargets,
): Promise<{ clashes: string[]; unreachable: string[] }> {
  try {
    const res = await authApi.post("/instance-wide/machines/preview", { kind, name, targets });
    return res.data as { clashes: string[]; unreachable: string[] };
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't check the machines"));
  }
}

export async function saveMachines(kind: InstanceWideKind, name: string, lists: SharedLists): Promise<SharedLists> {
  try {
    const res = await authApi.put("/instance-wide/machines", { kind, name, ...lists });
    return res.data as SharedLists;
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't save the machines"));
  }
}

export type PromotePreview = {
  files: number;
  bytes: number;
  tooLarge: boolean;
  clashes: string[];
  unreachable: string[];
  sourceHostName: string;
};

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  if (data?.error) return data.error;
  return error instanceof Error ? error.message : fallback;
}

export class InstanceWideError extends Error {}

export async function previewPromote(
  kind: InstanceWideKind,
  name: string,
  hostId: number,
  targets: SharedTargets = "all",
): Promise<PromotePreview> {
  try {
    const res = await authApi.post("/instance-wide/promote/preview", { kind, name, hostId, targets });
    return res.data as PromotePreview;
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't check the hosts"));
  }
}

export async function promote(
  kind: InstanceWideKind,
  name: string,
  hostId: number,
  lists: SharedLists = { targets: "all", writeBack: [] },
): Promise<void> {
  try {
    await authApi.post("/instance-wide/promote", { kind, name, hostId, ...lists });
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't make it instance-wide"));
  }
}

export async function removeInstanceWide(
  kind: InstanceWideKind,
  name: string,
): Promise<{ hostCount: number }> {
  try {
    const res = await authApi.delete("/instance-wide/items", { data: { kind, name } });
    return res.data as { hostCount: number };
  } catch (error) {
    throw new InstanceWideError(errorMessage(error, "Couldn't remove it"));
  }
}

/** Short status line: "" when every machine is current. */
export function syncSummary(item: Pick<InstanceWideItem, "behind" | "conflicts">): string {
  const parts: string[] = [];
  if (item.conflicts > 0) parts.push(`${item.conflicts} conflict${item.conflicts === 1 ? "" : "s"}`);
  if (item.behind > 0) parts.push(`${item.behind} machine${item.behind === 1 ? "" : "s"} behind`);
  return parts.join(" · ");
}

/** "every machine" / "1 machine" / "3 machines" — where an item goes. */
export function reachText(targets: SharedTargets): string {
  if (targets === "all") return "every machine";
  return `${targets.length} machine${targets.length === 1 ? "" : "s"}`;
}

/** The facts-line reach of a shared item: admins see how far, everyone else "shared". */
export function reachLabel(item: Pick<InstanceWideItem, "targets"> | null | undefined, isAdmin: boolean): string {
  if (!isAdmin || !item?.targets) return "shared";
  return `on ${reachText(item.targets)}`;
}

/** Lines warning that same-named folders will be replaced (clashes + offline machines). */
export function clashLines(kindLabel: string, name: string, c: { clashes: string[]; unreachable: string[] }): string[] {
  const lines: string[] = [];
  if (c.clashes.length > 0) {
    lines.push("", `These machines already have a ${kindLabel} named "${name}", which will be replaced: ${c.clashes.join(", ")}`);
  }
  if (c.unreachable.length > 0) {
    lines.push("", `Couldn't check (offline): ${c.unreachable.join(", ")} — any same-name ${kindLabel} there will be replaced when they come back.`);
  }
  return lines;
}

/** Text for the promote confirmation (blanket warning + clash list). */
export function promoteConfirmText(
  kindLabel: string,
  name: string,
  p: PromotePreview,
  targets: SharedTargets = "all",
): string {
  const size = p.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(p.bytes / 1024))} KB` : `${(p.bytes / 1024 / 1024).toFixed(1)} MB`;
  const where = targets === "all" ? "every machine" : `the ${reachText(targets)} you picked`;
  const lines = [
    `Make the ${kindLabel} "${name}" instance-wide?`,
    "",
    `Everything in its folder on ${p.sourceHostName} (${p.files} file${p.files === 1 ? "" : "s"}, ${size}) will be copied to ${where} and kept in step from now on — including anything private in that folder.`,
    ...clashLines(kindLabel, name, p),
  ];
  return lines.join("\n");
}
