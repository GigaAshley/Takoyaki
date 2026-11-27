/**
 * Phase 118 Plan 118-02 — Client-side surface to /workspace CRUD endpoints.
 *
 * This is the SOLE client-side surface for the /workspace backend router (Plan
 * 118-01). Every helper listed here is a 1:1 wrapper around one backend route.
 *
 * Target model: every helper takes a WorkspaceTarget as its first param — either
 *   { kind: "identity", identityKey } → resolves to ~/fleet/identities/<key>/workspace
 *   { kind: "role", roleSlug }        → resolves to ~/fleet/roles/<slug>
 *   { kind: "project", projectSlug }  → resolves to ~/fleet/projects/<slug>
 *   { kind: "host" }                  → the host login's home folder (admins only)
 * Wire shape stays byte-identical for identity requests (no `kind` field sent);
 * role and project requests carry { kind, roleSlug | projectSlug } instead of
 * { identityKey }.
 *
 * Error-class preservation (mirrors fetchHostFileUrl at editable-file-api.ts:131):
 * Each async helper catches axios errors and, when the response body carries a
 * backend error-class string (e.g. "permission_denied", "not_found",
 * "not_a_directory"), throws a plain Error whose .message IS that class string.
 * The caller (WorkspaceTab, Plan 118-03) can switch on err.message and look up
 * consumer-user copy from WORKSPACE_ERROR_COPY (Plan 118-02 Task 2 output).
 * Any axios error that does NOT carry a recognisable class falls through to
 * handleApiError (fleet-standard ApiError taxonomy for auth / network failures).
 *
 * NO React, NO UI, NO stateful side effects in this file.
 */

import axios from "axios";
import { authApi, handleApiError } from "@/main-axios";
import { FileChangedError } from "@/api/file-changed-error";

/** A save refused because the file isn't what was opened (or, for a new one, is already there). */
function changedFrom(error: unknown): FileChangedError | null {
  if (!axios.isAxiosError(error)) return null;
  const data = error.response?.data as { error?: string; version?: string | null } | undefined;
  if (data?.error === "file_changed") return new FileChangedError(data.version ?? null);
  if (data?.error === "file_exists") return new FileChangedError(data.version ?? null, true);
  return null;
}

/** Still waiting its turn on the machine: not saved yet. */
function stillSaving(): Error {
  const e = new Error("still_saving");
  e.name = "WorkspaceError";
  return e;
}

// ---------------------------------------------------------------------------
// Wire types (exported for consumers)
// ---------------------------------------------------------------------------

export type WorkspaceEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number | null; // null for directories
  mtimeMs: number; // Unix milliseconds (backend sends attrs.mtime * 1000)
  path: string; // relative path from workspace root
};

export type ListResponse = {
  entries: WorkspaceEntry[];
  path: string;
};

export type ReadFileResponse = {
  contentBase64: string;
  sizeBytes: number;
  filename: string;
  extension: string | null;
  /** What a save from the file window is checked against. */
  version?: string;
};

/**
 * Discriminated target passed to every workspace helper. `identity` maps to
 * ~/fleet/identities/<identityKey>/workspace; `role` maps to
 * ~/fleet/roles/<roleSlug>; `project` maps to ~/fleet/projects/<projectSlug>.
 * Backend `extractTarget` mirrors this shape.
 */
export type WorkspaceTarget =
  | { kind: "identity"; identityKey: string }
  // An archived agent's workspace (~/fleet/identities-archive/<key>/workspace)
  // — the server refuses every change to it.
  | { kind: "archived-identity"; identityKey: string }
  | { kind: "role"; roleSlug: string }
  | { kind: "project"; projectSlug: string }
  // The home folder of the host login's account — admin-only on the server.
  | { kind: "host" };

/**
 * Serialize a target into the wire fields the backend expects. Identity
 * requests omit `kind` so the wire is byte-identical to pre-role-support
 * callers; role requests send `{ kind: "role", roleSlug }`.
 */
function targetToWireFields(t: WorkspaceTarget): Record<string, string> {
  if (t.kind === "host") return { kind: "host" };
  if (t.kind === "role") return { kind: "role", roleSlug: t.roleSlug };
  if (t.kind === "project") return { kind: "project", projectSlug: t.projectSlug };
  if (t.kind === "archived-identity") return { kind: "archived-identity", identityKey: t.identityKey };
  return { identityKey: t.identityKey };
}

/** URL-encoded target query fragment for GET endpoints (currently /download). */
function targetToQueryString(t: WorkspaceTarget): string {
  if (t.kind === "host") return "kind=host";
  if (t.kind === "role") {
    return `kind=role&roleSlug=${encodeURIComponent(t.roleSlug)}`;
  }
  if (t.kind === "project") {
    return `kind=project&projectSlug=${encodeURIComponent(t.projectSlug)}`;
  }
  if (t.kind === "archived-identity") {
    return `kind=archived-identity&identityKey=${encodeURIComponent(t.identityKey)}`;
  }
  return `identityKey=${encodeURIComponent(t.identityKey)}`;
}

// ---------------------------------------------------------------------------
// List directory — POST /workspace/list
// ---------------------------------------------------------------------------

/**
 * List the contents of a workspace directory.
 *
 * @param target       - Identity workspace or role folder
 * @param hostId       - Numeric host ID (from IdentityModal.hostId)
 * @param relativePath - Path relative to workspace root; "" for root
 */
export async function listWorkspace(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<ListResponse> {
  try {
    const response = await authApi.post("/workspace/list", {
      ...targetToWireFields(target),
      hostId,
      relativePath,
    });
    return response.data as ListResponse;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "list workspace");
    throw error; // unreachable — handleApiError throws; satisfies TS return type
  }
}

// ---------------------------------------------------------------------------
// Search names — POST /workspace/search
// ---------------------------------------------------------------------------

export type SearchResponse = {
  /** Matches; each path is relative to the target root, like list entries. */
  results: WorkspaceEntry[];
  /** More matched than the server returns; the first ones are shown. */
  truncated: boolean;
  /** The server's time limit stopped the search; there may be more. */
  timedOut: boolean;
};

/**
 * Search file and folder names under a folder, subfolders included. Every
 * whitespace-separated word of `query` must appear in a name (any order,
 * case ignored). Pass `signal` so a superseded search is cancelled — the
 * server stops the search on the host when the request goes away.
 *
 * @param relativePath - Folder searched from, relative to the target root; "" for root
 */
export async function searchWorkspace(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  try {
    const response = await authApi.post(
      "/workspace/search",
      { ...targetToWireFields(target), hostId, relativePath, query },
      { signal },
    );
    return response.data as SearchResponse;
  } catch (error) {
    if (axios.isCancel(error)) throw error;
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "search workspace");
    throw error; // unreachable — handleApiError throws; satisfies TS return type
  }
}

// ---------------------------------------------------------------------------
// Read file — POST /workspace/read-file
// ---------------------------------------------------------------------------

/**
 * Read a file from the workspace. Returns base64-encoded content.
 * The backend enforces a 2 MB size cap (returns "too_large" if exceeded).
 */
export async function readWorkspaceFile(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<ReadFileResponse> {
  try {
    const response = await authApi.post("/workspace/read-file", {
      ...targetToWireFields(target),
      hostId,
      relativePath,
    });
    return response.data as ReadFileResponse;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "read workspace file");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Write file — PUT /workspace/write-file
// ---------------------------------------------------------------------------

/**
 * Write UTF-8 text content to a file in the workspace (atomic tmp+rename).
 */
export async function writeWorkspaceFile(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
  content: string,
  /** The version it was opened at ("absent": a new file). Refused with FileChangedError
   *  when it isn't that any more; resolves with the new version. */
  version: string,
): Promise<{ version: string }> {
  try {
    const response = await authApi.put("/workspace/write-file", {
      ...targetToWireFields(target),
      hostId,
      relativePath,
      content,
      version,
    });
    if (response.status === 202) throw stillSaving();
    return { version: String((response.data as { version?: unknown }).version ?? "") };
  } catch (error) {
    const changed = changedFrom(error);
    if (changed) throw changed;
    if (error instanceof Error && error.name === "WorkspaceError") throw error;
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "write workspace file");
    throw error;
  }
}

/** The version of a file a viewer streams itself (a PDF): what its save is checked against. */
export async function workspaceFileVersion(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<string> {
  const response = await authApi.post("/workspace/version", { ...targetToWireFields(target), hostId, relativePath });
  return String((response.data as { version?: unknown }).version ?? "");
}

// ---------------------------------------------------------------------------
// Delete entry — DELETE /workspace/entry
// ---------------------------------------------------------------------------

/**
 * Delete a file, or a folder together with everything in it. A symlink is
 * removed itself; what it points at is left alone.
 */
export async function deleteWorkspaceEntry(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<void> {
  try {
    // axios.delete sends body via config.data option
    await authApi.delete("/workspace/entry", {
      data: { ...targetToWireFields(target), hostId, relativePath },
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "delete workspace entry");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rename — POST /workspace/rename
// ---------------------------------------------------------------------------

/**
 * Rename or move a workspace entry.
 */
export async function renameWorkspaceEntry(
  target: WorkspaceTarget,
  hostId: number,
  from: string,
  to: string,
): Promise<void> {
  try {
    await authApi.post("/workspace/rename", {
      ...targetToWireFields(target),
      hostId,
      from,
      to,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "rename workspace entry");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Create directory — POST /workspace/mkdir
// ---------------------------------------------------------------------------

/**
 * Create a directory in the workspace.
 */
export async function mkdirWorkspace(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<void> {
  try {
    await authApi.post("/workspace/mkdir", {
      ...targetToWireFields(target),
      hostId,
      relativePath,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "create workspace folder");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Create file — POST /workspace/create-file
// ---------------------------------------------------------------------------

/**
 * Create an empty file in the workspace.
 */
export async function createWorkspaceFile(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
): Promise<void> {
  try {
    await authApi.post("/workspace/create-file", {
      ...targetToWireFields(target),
      hostId,
      relativePath,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "create workspace file");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Upload file — POST /workspace/upload (multipart)
// ---------------------------------------------------------------------------

/**
 * Upload a browser File object to the workspace.
 * Sends a multipart form-data body with target + hostId + relativePath fields
 * plus the file payload. Calls onProgress during upload if supplied.
 */
export async function uploadWorkspaceFile(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  /** Left out: a new file — one of that name already there is refused with
   *  FileChangedError (exists), whose version a Replace sends back. Given: written only
   *  over that version. */
  version?: string,
): Promise<{ version: string }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(targetToWireFields(target))) {
    form.append(k, v);
  }
  form.append("hostId", String(hostId));
  form.append("relativePath", relativePath);
  if (version !== undefined) form.append("version", version);
  form.append("file", file);

  try {
    const response = await authApi.post("/workspace/upload", form, {
      // authApi defaults to application/json. Without an explicit
      // multipart/form-data header, axios v1's formDataToJSON transform
      // fires and drops the File field entirely, and multer returns
      // invalid_body with req.file undefined (regression documented at
      // identities-api.ts:519 — same failure mode, same fix).
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: onProgress
        ? (e) => onProgress(e.loaded, e.total ?? file.size)
        : undefined,
    });
    if (response.status === 202) throw stillSaving();
    return { version: String((response.data as { version?: unknown }).version ?? "") };
  } catch (error) {
    const changed = changedFrom(error);
    if (changed) throw changed;
    if (error instanceof Error && error.name === "WorkspaceError") throw error;
    if (axios.isAxiosError(error)) {
      const backendClass = error.response?.data?.error;
      if (typeof backendClass === "string" && backendClass.length > 0) {
        const rich = new Error(backendClass);
        rich.name = "WorkspaceError";
        throw rich;
      }
    }
    handleApiError(error, "upload workspace file");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Download file URL builder — synchronous, no network call
// ---------------------------------------------------------------------------

/**
 * Build the URL for downloading a workspace file via the browser's native
 * download mechanism. Caller triggers by setting window.location.href or
 * creating an <a download> element.
 *
 * Uses a relative URL (no origin prefix) because the frontend and backend
 * share the same origin under the nginx reverse proxy.
 */
export function downloadWorkspaceFileUrl(
  target: WorkspaceTarget,
  hostId: number,
  relativePath: string,
  opts: { inline?: boolean } = {},
): string {
  return (
    `/workspace/download` +
    `?${targetToQueryString(target)}` +
    `&hostId=${encodeURIComponent(String(hostId))}` +
    `&relativePath=${encodeURIComponent(relativePath)}` +
    // inline=1: served in place (media / PDF / text) for viewers to use as
    // a src, with Range support. html / js / svg still download.
    (opts.inline ? "&inline=1" : "")
  );
}
