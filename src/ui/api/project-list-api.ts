import { authApi, handleApiError } from "@/main-axios";
import { inMachineOrder, sendMachineChange, type MachineChangeAnswer } from "@/api/machine-changes-api";

// ─── Phase 117 Plan 117-06 (D-25 / D-28 / D-30) — project-list-api ──────────
//
// Thin fetch wrappers for the three /projects endpoints landed by Plan 117-04.
// Byte-shape mirror of identity-archive-api.ts: authApi + handleApiError, one
// try/catch per wrapper, no error swallowing.
//
// Endpoints:
//   GET  /projects?hostId=<n>          → { projects: ProjectSummary[] }
//   POST /projects                     body { hostId, displayName }
//                                        → { ok: true, slug }
//                                        (409 on duplicate slug → error
//                                         propagated via handleApiError with
//                                         the "create project" operation
//                                         label so the modal can detect it
//                                         and surface a specific message)
//   POST /projects/:slug/archive       body { hostId, expected, requestId }
//                                        → { ok, requestId, result } (the
//                                          machine's front door; see below)
//   POST /projects/:slug/parent        body { hostId, parent|null }
//                                        → { ok: true }
//   GET  /projects/:slug/archive-preflight?hostId=<n>
//                                        → { hiddenSubProjects: number }
//
// Backend-authoritative slug derivation (D-25, Pitfall 1 in RESEARCH):
// createProject submits the raw displayName; the response body carries the
// slug produced by the backend's normalizeToSlug. The frontend NEVER computes
// the slug at runtime.
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

export async function createProject(
  hostId: number,
  displayName: string,
  parent?: string | null,
): Promise<{ ok: true; slug: string }> {
  try {
    const body: { hostId: number; displayName: string; parent?: string } = {
      hostId,
      displayName,
    };
    if (parent) body.parent = parent;
    const response = await authApi.post("/projects", body);
    return response.data as { ok: true; slug: string };
  } catch (error) {
    handleApiError(error, "create project");
  }
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
export async function setProjectParent(
  hostId: number,
  slug: string,
  parent: string | null,
): Promise<{ ok: true }> {
  try {
    const url = `/projects/${encodeURIComponent(slug)}/parent`;
    const response = await authApi.post(url, { hostId, parent });
    return response.data as { ok: true };
  } catch (error) {
    handleApiError(error, "move project");
  }
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
): Promise<{ markdown: string }> {
  try {
    const url = `/projects/${encodeURIComponent(slug)}/file?hostId=${encodeURIComponent(String(hostId))}`;
    const response = await authApi.get(url);
    return response.data as { markdown: string };
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
): Promise<{ markdown: string }> {
  try {
    const url = `/projects/${encodeURIComponent(slug)}/file`;
    const response = await authApi.put(url, { hostId, contents });
    return response.data as { markdown: string };
  } catch (error) {
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
