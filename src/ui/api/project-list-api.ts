import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";
import { FileChangedError } from "@/api/file-changed-error";
import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

// ─── Phase 117 Plan 117-06 (D-25 / D-28 / D-30) — project-list-api ──────────
//
// Thin fetch wrappers for the three /projects endpoints landed by Plan 117-04.
// Byte-shape mirror of identity-archive-api.ts: authApi + handleApiError, one
// try/catch per wrapper, no error swallowing.
//
// Endpoints:
//   GET  /projects?hostId=<n>          → { projects: ProjectSummary[] }
//   POST /projects                     body { hostId, displayName, parent?, requestId }
//                                        → { ok, requestId, result: { slug, … } }
//                                        (the machine's front door; it picks
//                                         a free slug)
//   POST /projects/:slug/archive       body { hostId, expected, requestId }
//                                        → { ok, requestId, result } (the
//                                          machine's front door; see below)
//   POST /projects/:slug/parent        body { hostId, parent|null, requestId }
//   POST /projects/:slug/rename        body { hostId, displayName, requestId }
//                                        → { ok, requestId, result } (front door)
//   GET  /projects/:slug/archive-preflight?hostId=<n>
//                                        → { hiddenSubProjects: number }
//
// Backend-authoritative slug derivation (D-25, Pitfall 1 in RESEARCH):
// createProject submits the raw displayName; the answer carries the slug the
// machine gave it. The frontend NEVER computes the slug at runtime.
//
// Errors flow through handleApiError (main-axios.ts) so callers see the same
// ApiError / message shape every other API surface produces — keeps the
// callsite catch-and-log path uniform.

/**
 * Summary of a project as returned by GET /projects.
 * Backend guarantees archived===false in this list (GET /projects excludes
 * the archive/ subdir per D-30); the field is retained on the type for
 * symmetry with the wire-protocol schema.
 */
export type ProjectSummary = {
  slug: string;
  displayName: string;
  archived: boolean;
  /** Raw parent slug on the same host, or null/absent for top level. */
  parent?: string | null;
};

export async function listProjects(
  hostId: number,
): Promise<{ projects: ProjectSummary[] }> {
  try {
    const url = `/projects?hostId=${encodeURIComponent(String(hostId))}`;
    const response = await authApi.get(url);
    return response.data as { projects: ProjectSummary[] };
  } catch (error) {
    handleApiError(error, "list projects");
  }
}

/**
 * A quick project change at the machine's front door (create, rename, move), in order with
 * the machine's other changes. Refusals throw MachineChangeError with the machine's reason;
 * one still waiting its turn after the follow-ups throws too, saying so (the machine still
 * carries it out, and the sidebar shows it when it lands).
 */
async function projectChange<T>(hostId: number, url: string, body: Record<string, unknown>, operation: string): Promise<T> {
  const answer = await sendProjectChange<T>(hostId, url, body, operation);
  if (!answer.done) throw new Error("the machine is still working on it; it'll show once it's done");
  return answer.result.result;
}

function sendProjectChange<T>(
  hostId: number,
  url: string,
  body: Record<string, unknown>,
  operation: string,
): Promise<MachineChangeAnswer<{ result: T }>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange<{ result: T }>(hostId, { method: "post", url, body: { hostId, ...body } }, operation, {
      followUp: "resend",
    }),
  );
}

export async function createProject(
  hostId: number,
  displayName: string,
  parent?: string | null,
): Promise<{ ok: true; slug: string }> {
  const result = await projectChange<{ slug: string }>(
    hostId,
    "/projects",
    { displayName, ...(parent ? { parent } : {}) },
    "create project",
  );
  return { ok: true, slug: result.slug };
}

/** Change a project's name (its displayName line only). */
export async function renameProject(hostId: number, slug: string, displayName: string): Promise<{ ok: true }> {
  await projectChange(hostId, `/projects/${encodeURIComponent(slug)}/rename`, { displayName }, "rename project");
  return { ok: true };
}

/** What a project archive takes, as the machine sees it. */
export interface ProjectArchiveContents {
  project: string;
  projects: Array<{ slug: string; displayName: string; parent: string | null }>;
  agents: Array<{ name: string; displayName: string; task: string; project: string }>;
  apps: Array<{ slug: string; title: string; project: string }>;
}

export interface ProjectArchivePreflight {
  /** Sub-projects beneath it hidden from the caller (archiving is refused when not 0). */
  hiddenSubProjects: number;
  /** What it holds — null when some of it is hidden from the caller (archiving is refused). */
  contents: ProjectArchiveContents | null;
  /** The caller's relay rooms filed in any of them, from the chat server. */
  rooms: Array<{ roomId: string; project: string }>;
  /** The chat server couldn't be asked, so `rooms` is unknown. */
  roomsUnknown: boolean;
}

export interface ProjectArchiveResult {
  projects: Array<{ slug: string; archivedAs: string | null }>;
  agents: string[];
  apps: Array<{ slug: string; project: string }>;
  rooms: Array<{ roomId: string; project: string }>;
}

/** The names of what the user confirmed, as the archive request carries them. */
export function expectedFromContents(c: ProjectArchiveContents): { projects: string[]; agents: string[]; apps: string[] } {
  return {
    projects: c.projects.map((p) => p.slug),
    agents: c.agents.map((a) => a.name),
    apps: c.apps.map((a) => a.slug),
  };
}

/**
 * Archive a project and everything in it, through the machine's front door,
 * in turn after this machine's earlier changes. `expected` is what the
 * confirm showed; when the machine's contents changed since, this throws a
 * MachineChangeError with code "contents_changed" and the current contents
 * as its result. Other refusals and failures throw with the machine's reason.
 *
 * POST /projects/:slug/archive  body { hostId, expected, requestId }
 */
export function archiveProject(
  hostId: number,
  slug: string,
  expected: { projects: string[]; agents: string[]; apps: string[] },
  onStillWorking?: () => void,
): Promise<MachineChangeAnswer<{ ok: true; requestId: string; result: ProjectArchiveResult }>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange(
      hostId,
      { method: "post", url: `/projects/${encodeURIComponent(slug)}/archive`, body: { hostId, expected } },
      "archive the project",
      { followUp: "resend", onStillWorking },
    ),
  );
}

/**
 * What archiving `slug` would take, asked of the machine in turn after this
 * machine's earlier changes (so moves just clicked are already done), plus
 * the sub-projects hidden from the caller and the caller's rooms in it.
 * `done: false` = the machine is still busy; try again in a moment.
 *
 * GET /projects/:slug/archive-preflight?hostId=<n>
 */
export function getArchivePreflight(
  hostId: number,
  slug: string,
): Promise<MachineChangeAnswer<ProjectArchivePreflight>> {
  return inMachineOrder(hostId, () =>
    sendMachineChange<ProjectArchivePreflight>(
      hostId,
      {
        method: "get",
        url: `/projects/${encodeURIComponent(slug)}/archive-preflight?hostId=${encodeURIComponent(String(hostId))}`,
      },
      "check project before archive",
      { followUp: "none" },
    ),
  );
}

/**
 * Nest a project under another project on the same host, or return it to
 * top level with `parent: null`.
 *
 * POST /projects/:slug/parent  body { hostId, parent }  →  { ok: true }
 * 400 = parent not found, 409 = parent is the project itself or inside it.
 */
/**
 * Move a project (under `parent`, or to the top level). Resolves with the machine's answer;
 * `done: false` = still waiting its turn (whenMachineDone says how it ends). Refusals throw
 * MachineChangeError with the machine's reason.
 */
export function setProjectParent(
  hostId: number,
  slug: string,
  parent: string | null,
): Promise<MachineChangeAnswer<unknown>> {
  return sendProjectChange(hostId, `/projects/${encodeURIComponent(slug)}/parent`, { parent }, "move project");
}

/**
 * Read the project.md file for a given slug.
 *
 * GET /projects/:slug/file?hostId=<n>  →  { markdown: string }
 *
 * Returns an empty markdown string when the file is missing (mirrors the
 * backend readProjectFile ENOENT contract) — the modal treats that as an
 * unedited-yet project rather than an error.
 */
export async function getProjectFile(
  hostId: number,
  slug: string,
): Promise<{ markdown: string; version: string }> {
  try {
    const url = `/projects/${encodeURIComponent(slug)}/file?hostId=${encodeURIComponent(String(hostId))}`;
    const response = await authApi.get(url);
    return response.data as { markdown: string; version: string };
  } catch (error) {
    handleApiError(error, "read project file");
  }
}

/**
 * Overwrite the project.md file for a given slug.
 *
 * PUT /projects/:slug/file  body { hostId, contents }  →  { markdown: string }
 *
 * Server-echoes the written body so the modal replaces its local state with
 * an authoritative snapshot on save (no separate GET round-trip needed).
 */
export async function updateProjectFile(
  hostId: number,
  slug: string,
  contents: string,
  /** The version it was opened at: the machine writes it only over that. */
  version: string,
): Promise<{ markdown: string; version: string }> {
  try {
    const url = `/projects/${encodeURIComponent(slug)}/file`;
    const response = await authApi.put(url, { hostId, contents, version });
    // Still waiting its turn on the machine: not saved yet, so the editor keeps the draft.
    if (response.status === 202) throw new Error((response.data as { error?: string }).error ?? "still saving");
    return response.data as { markdown: string; version: string };
  } catch (error) {
    const data = (axios.isAxiosError(error) ? error.response?.data : undefined) as
      | { code?: string; version?: string | null; error?: string }
      | undefined;
    if (data?.code === "changed") throw new FileChangedError(data.version ?? null);
    handleApiError(error, "update project file");
  }
}

/**
 * Phase 117 Plan 117-07 (Fix 1 / D-05 relay-room carrier): boot-time
 * enumerator that returns every joined relay-room whose account_data carries
 * a `u.project.<slug>` tag. AppShell aggregates the per-host results into a
 * flat Map<roomId, slug> and passes it to setRoomProjectAssignments before
 * the first render.
 *
 * Endpoint: GET /relay-rooms/project-tags?hostId=<n>
 * Response: `{ assignments: Array<{ roomId: string, slug: string }> }`
 *
 * Partial-hydration discipline: per-room Matrix errors are swallowed
 * server-side (logged as warn, entry omitted from the returned array). The
 * frontend just consumes whatever the backend returns.
 */
export async function listRelayRoomProjectTags(
  hostId: number,
): Promise<{ assignments: Array<{ roomId: string; slug: string }>; pinned: string[]; unknown: string[] }> {
  try {
    const url = `/relay-rooms/project-tags?hostId=${encodeURIComponent(String(hostId))}`;
    const response = await authApi.get(url);
    const data = response.data as {
      assignments: Array<{ roomId: string; slug: string }>;
      pinned?: unknown;
      unknown?: unknown;
    };
    const ids = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : [];
    // `pinned` = rooms the user has pinned; `unknown` = rooms whose tags
    // couldn't be read this time (keep what's already known for them).
    return { assignments: data.assignments, pinned: ids(data.pinned), unknown: ids(data.unknown) };
  } catch (error) {
    handleApiError(error, "list relay-room project tags");
  }
}
